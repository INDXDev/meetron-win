#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let messageListener;
let connectListener;
let nativeMessageListener;
let nativeConnections = 0;

const chrome = {
  runtime: {
    id: "jlikakgdldiihhflkobhnpfegjlcakdd",
    getURL: (path) => `chrome-extension://jlikakgdldiihhflkobhnpfegjlcakdd${path}`,
    connectNative: () => {
      nativeConnections += 1;
      return {
        onMessage: { addListener: (listener) => { nativeMessageListener = listener; } },
        onDisconnect: { addListener: () => {} },
        postMessage: (message) => {
          nativeMessageListener?.({ ...message, ok: true, data: {} });
        },
      };
    },
    onMessage: {
      addListener: (listener) => {
        messageListener = listener;
      },
    },
    onConnect: {
      addListener: (listener) => {
        connectListener = listener;
      },
    },
  },
};

const source = await readFile(resolve(repoRoot, "extension/service-worker.js"), "utf8");
const manifest = JSON.parse(await readFile(resolve(repoRoot, "extension/manifest.json"), "utf8"));
const audioBridgeRegistration = manifest.content_scripts.find((entry) =>
  entry.js.includes("audio-bridge-content-script.js"));
if (
  !manifest.host_permissions.includes("https://chatgpt.com/*") ||
  audioBridgeRegistration?.run_at !== "document_start" ||
  !audioBridgeRegistration.matches.includes("https://meet.google.com/*") ||
  !audioBridgeRegistration.matches.includes("https://*.zoom.us/*")
) {
  throw new Error("The extension does not load the audio bridge early on every loopback peer.");
}
vm.runInNewContext(source, { chrome, URL, Error, Map, Set, Promise, setTimeout, clearTimeout });

function request(type, sender) {
  let response;
  const asynchronous = messageListener(
    { channel: "meeting-copilot", type: "native-request", request: { type, payload: {} } },
    sender,
    (value) => {
      response = value;
    },
  );
  return { asynchronous, response };
}

const foreign = request("status.get", {
  id: "another-extension",
  url: "https://meet.google.com/abc-defg-hij",
});
const privilegedFromMeet = request("setup.audio.configure", {
  id: chrome.runtime.id,
  url: "https://meet.google.com/abc-defg-hij",
});
const invalidMeetPath = request("status.get", {
  id: chrome.runtime.id,
  url: "https://meet.google.com/landing",
});
const invalidZoomPath = request("status.get", {
  id: chrome.runtime.id,
  url: "https://app.zoom.us/profile",
});

if (
  foreign.asynchronous !== false ||
  foreign.response?.ok !== false ||
  privilegedFromMeet.asynchronous !== false ||
  privilegedFromMeet.response?.ok !== false ||
  invalidMeetPath.asynchronous !== false ||
  invalidMeetPath.response?.ok !== false ||
  invalidZoomPath.asynchronous !== false ||
  invalidZoomPath.response?.ok !== false ||
  nativeConnections !== 0
) {
  throw new Error("Service worker accepted an unauthorized Native Host request.");
}

let screenshotResponse;
const screenshotAsynchronous = messageListener(
  {
    channel: "meeting-copilot",
    type: "native-request",
    request: { type: "visual-context.screenshot.send", payload: {} },
  },
  {
    id: chrome.runtime.id,
    url: "https://meet.google.com/abc-defg-hij",
  },
  (value) => { screenshotResponse = value; },
);
await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
if (screenshotAsynchronous !== true || screenshotResponse?.ok !== true) {
  throw new Error("Service worker rejected an authorized Meet screenshot request.");
}

let zoomScreenshotResponse;
const zoomScreenshotAsynchronous = messageListener(
  {
    channel: "meeting-copilot",
    type: "native-request",
    request: { type: "visual-context.screenshot.send", payload: {} },
  },
  {
    id: chrome.runtime.id,
    url: "https://app.zoom.us/wc/join/12345678901",
  },
  (value) => { zoomScreenshotResponse = value; },
);
await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
if (zoomScreenshotAsynchronous !== true || zoomScreenshotResponse?.ok !== true) {
  throw new Error("Service worker rejected an authorized Zoom screenshot request.");
}

let zoomResponse;
const zoomAsynchronous = messageListener(
  {
    channel: "meeting-copilot",
    type: "native-request",
    request: { type: "participant.mic.set", payload: { state: "unmuted" } },
  },
  {
    id: chrome.runtime.id,
    url: "https://app.zoom.us/wc/join/12345678901",
  },
  (value) => { zoomResponse = value; },
);
await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
if (zoomAsynchronous !== true || zoomResponse?.ok !== true || nativeConnections !== 1) {
  throw new Error("Service worker rejected an authorized Zoom meeting control request.");
}

let reconcileResponse;
const reconcileAsynchronous = messageListener(
  {
    channel: "meeting-copilot",
    type: "native-request",
    request: { type: "session.reconcile", payload: {} },
  },
  {
    id: chrome.runtime.id,
    url: "https://app.zoom.us/wc/12345678901/join",
  },
  (value) => { reconcileResponse = value; },
);
await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
if (reconcileAsynchronous !== true || reconcileResponse?.ok !== true) {
  throw new Error("Service worker rejected the dedicated Zoom reconciliation request.");
}

function audioPort(name, url) {
  let messageHandler;
  let disconnectHandler;
  return {
    name,
    sender: { id: chrome.runtime.id, url },
    posted: [],
    disconnected: false,
    onMessage: { addListener: (listener) => { messageHandler = listener; } },
    onDisconnect: { addListener: (listener) => { disconnectHandler = listener; } },
    postMessage(message) { this.posted.push(message); },
    disconnect() { this.disconnected = true; disconnectHandler?.(); },
    receive(message) { messageHandler?.(message); },
  };
}

const spoofed = audioPort("meetron-audio-loopback", "https://meet.google.com/abc-defg-hij");
connectListener(spoofed);
spoofed.receive({ type: "register", role: "chatgpt" });
if (!spoofed.disconnected) {
  throw new Error("Service worker accepted a meeting page as the ChatGPT audio peer.");
}
const offMeeting = audioPort("meetron-audio-loopback", "https://meet.google.com/landing");
connectListener(offMeeting);
offMeeting.receive({ type: "register", role: "meeting" });
if (!offMeeting.disconnected) {
  throw new Error("Service worker accepted an unrelated Meet page as an audio peer.");
}

const chatgptPeer = audioPort("meetron-audio-loopback", "https://chatgpt.com/g/g-p-test/project");
const meetingPeer = audioPort("meetron-audio-loopback", "https://app.zoom.us/wc/12345678901/join");
connectListener(chatgptPeer);
connectListener(meetingPeer);
chatgptPeer.receive({ type: "register", role: "chatgpt" });
meetingPeer.receive({ type: "register", role: "meeting" });
if (
  chatgptPeer.posted.at(-1)?.type !== "peer-ready" ||
  meetingPeer.posted.at(-1)?.type !== "peer-ready"
) {
  throw new Error("Service worker did not pair the two authorized audio roles.");
}

const description = { type: "offer", sdp: "fixture" };
chatgptPeer.receive({ type: "signal", description });
if (meetingPeer.posted.at(-1)?.description !== description) {
  throw new Error("Service worker did not relay WebRTC signaling to the counterpart.");
}
const relayedCount = meetingPeer.posted.length;
chatgptPeer.receive({ type: "signal", description: { type: "rollback", sdp: "" } });
if (meetingPeer.posted.length !== relayedCount) {
  throw new Error("Service worker relayed a malformed WebRTC description.");
}
meetingPeer.disconnect();
if (chatgptPeer.posted.at(-1)?.type !== "peer-disconnected") {
  throw new Error("Service worker did not report an audio peer disconnect.");
}

process.stdout.write("Service worker authorization and audio signaling passed.\n");
