(() => {
  const CHANNEL = "meetron-webrtc-loopback";
  let port = null;
  let registeredRole = "";

  function roleAllowedForPage(role) {
    if (role === "chatgpt") return location.origin === "https://chatgpt.com";
    if (role !== "meeting") return false;
    if (location.origin === "https://meet.google.com") {
      return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(location.pathname);
    }
    return location.protocol === "https:" &&
      (location.hostname === "zoom.us" || location.hostname.endsWith(".zoom.us")) &&
      /^\/wc\/(?:\d+\/(?:join|start|client)|(?:join|start)\/\d+)\/?$/i.test(location.pathname);
  }

  function sendToPage(message) {
    window.postMessage({
      channel: CHANNEL,
      direction: "extension-to-page",
      ...message,
    }, location.origin);
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      message?.channel !== CHANNEL ||
      message?.direction !== "page-to-extension" ||
      !roleAllowedForPage(message.role)
    ) return;

    if (message.type === "register") {
      if (port && registeredRole === message.role) return;
      port?.disconnect();
      registeredRole = message.role;
      port = chrome.runtime.connect({ name: "meetron-audio-loopback" });
      port.onMessage.addListener(sendToPage);
      port.onDisconnect.addListener(() => {
        port = null;
        registeredRole = "";
        sendToPage({ type: "peer-disconnected" });
      });
      port.postMessage({ type: "register", role: registeredRole });
      return;
    }

    if (message.type === "signal" && port && message.role === registeredRole) {
      port.postMessage({
        type: "signal",
        description: message.description,
        candidate: message.candidate,
      });
    }
  });

  sendToPage({ type: "bridge-ready" });
})();
