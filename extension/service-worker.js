const HOST_NAME = "com.meeting_copilot.host";
const PROTOCOL_VERSION = 1;
const pending = new Map();
let nativePort = null;
let requestSequence = 0;
const audioPeers = new Map();
const audioRoles = new Map();
const CONTENT_REQUESTS = new Set([
  "status.get",
  "session.status.get",
  "session.reconcile",
  "meet.mic.toggle",
  "participant.mic.toggle",
  "participant.mic.set",
  "voice.restart",
  "session.stop",
  "diagnostics.run",
  "visual-context.screenshot.send",
]);

function senderMayRequest(sender, requestType) {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== "string") {
    return false;
  }

  let url;
  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }

  if (url.origin === new URL(chrome.runtime.getURL("/")).origin) {
    return true;
  }

  const isMeet =
    url.origin === "https://meet.google.com" &&
    /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\/)?$/i.test(url.pathname);
  const isZoom =
    url.protocol === "https:" &&
    (url.hostname === "zoom.us" || url.hostname.endsWith(".zoom.us")) &&
    /^\/wc\/(?:(?:join|start)\/\d+|\d+\/(?:join|start))(?:\/)?$/i.test(url.pathname);
  return (isMeet || isZoom) && CONTENT_REQUESTS.has(requestType);
}

function audioRoleAllowed(port, role) {
  if (
    port.name !== "meetron-audio-loopback" ||
    port.sender?.id !== chrome.runtime.id ||
    typeof port.sender?.url !== "string"
  ) {
    return false;
  }
  let url;
  try {
    url = new URL(port.sender.url);
  } catch {
    return false;
  }
  if (role === "chatgpt") return url.origin === "https://chatgpt.com";
  if (role !== "meeting") return false;
  if (url.origin === "https://meet.google.com") {
    return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(url.pathname);
  }
  return url.protocol === "https:" &&
    (url.hostname === "zoom.us" || url.hostname.endsWith(".zoom.us")) &&
    /^\/wc\/(?:\d+\/(?:join|start|client)|(?:join|start)\/\d+)\/?$/i.test(url.pathname);
}

function validAudioSignal(message) {
  if (!message || message.type !== "signal") return false;
  if (message.description) {
    return !message.candidate &&
      ["offer", "answer"].includes(message.description.type) &&
      typeof message.description.sdp === "string" &&
      message.description.sdp.length <= 1_000_000;
  }
  return Boolean(message.candidate) &&
    typeof message.candidate.candidate === "string" &&
    message.candidate.candidate.length <= 8_192;
}

function notifyAudioPair() {
  const chatgpt = audioPeers.get("chatgpt");
  const meeting = audioPeers.get("meeting");
  if (!chatgpt || !meeting) return;
  chatgpt.postMessage({ type: "peer-ready" });
  meeting.postMessage({ type: "peer-ready" });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "meetron-audio-loopback") return;
  port.onMessage.addListener((message) => {
    if (message?.type === "register") {
      if (!audioRoleAllowed(port, message.role)) {
        port.disconnect();
        return;
      }
      const previous = audioPeers.get(message.role);
      if (previous && previous !== port) previous.postMessage({ type: "peer-disconnected" });
      audioPeers.set(message.role, port);
      audioRoles.set(port, message.role);
      notifyAudioPair();
      return;
    }
    if (!validAudioSignal(message)) return;
    const role = audioRoles.get(port);
    if (!role || audioPeers.get(role) !== port) return;
    const counterpart = audioPeers.get(role === "chatgpt" ? "meeting" : "chatgpt");
    counterpart?.postMessage({
      type: "signal",
      description: message.description,
      candidate: message.candidate,
    });
  });
  port.onDisconnect.addListener(() => {
    const role = audioRoles.get(port);
    audioRoles.delete(port);
    if (!role || audioPeers.get(role) !== port) return;
    audioPeers.delete(role);
    const counterpart = audioPeers.get(role === "chatgpt" ? "meeting" : "chatgpt");
    counterpart?.postMessage({ type: "peer-disconnected" });
  });
});

function rejectPending(message) {
  for (const { reject, timeout } of pending.values()) {
    clearTimeout(timeout);
    reject(new Error(message));
  }
  pending.clear();
}

function connectHost() {
  if (nativePort) {
    return nativePort;
  }

  const port = chrome.runtime.connectNative(HOST_NAME);
  nativePort = port;

  port.onMessage.addListener((message) => {
    const responseId = message.requestId || message.id;
    const entry = pending.get(responseId);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timeout);
    pending.delete(responseId);
    entry.resolve(message);
  });

  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || "Native Host disconnected.";
    if (nativePort === port) {
      nativePort = null;
    }
    rejectPending(error);
  });

  return port;
}

function requestHost(request) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${requestSequence += 1}`;
    const timeoutMs = request.type === "voice.restart"
      ? 150_000
      : ["session.stop", "visual-context.screenshot.send"].includes(request.type)
        ? 60_000
        : 20_000;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Native Host request timed out."));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timeout });
    try {
      connectHost().postMessage({
        ...request,
        protocolVersion: PROTOCOL_VERSION,
        requestId: id,
        id,
      });
    } catch (error) {
      clearTimeout(timeout);
      pending.delete(id);
      reject(error);
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.channel !== "meeting-copilot" || message?.type !== "native-request") {
    return false;
  }

  if (!senderMayRequest(sender, message.request?.type)) {
    sendResponse({ ok: false, error: "This extension context cannot perform that request." });
    return false;
  }

  requestHost(message.request)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});
