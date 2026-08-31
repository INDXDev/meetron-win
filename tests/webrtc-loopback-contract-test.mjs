#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installWebRtcLoopbackPage,
  WEBRTC_LOOPBACK_BACKEND_ID,
  WEBRTC_LOOPBACK_CHANNEL,
} from "../src/audio/webrtc-loopback-page.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(WEBRTC_LOOPBACK_BACKEND_ID, "webrtc-loopback");
assert.equal(WEBRTC_LOOPBACK_CHANNEL, "meetron-webrtc-loopback");
assert.throws(() => installWebRtcLoopbackPage({ role: "invalid" }), /chatgpt or meeting role/);
assert.throws(() => installWebRtcLoopbackPage({ role: "chatgpt" }), /Web Audio and WebRTC APIs/);

for (const script of ["prepare-chatgpt-live.mjs", "prepare-meet.mjs", "prepare-zoom.mjs"]) {
  const source = await readFile(resolve(repoRoot, "scripts", script), "utf8");
  assert.match(source, /WEBRTC_LOOPBACK_BACKEND_ID/);
  assert.match(source, /installWebRtcLoopbackPage/);
}
const contentBridge = await readFile(
  resolve(repoRoot, "extension/audio-bridge-content-script.js"),
  "utf8",
);
assert.match(contentBridge, /event\.source !== window/);
assert.match(contentBridge, /event\.origin !== location\.origin/);
assert.match(contentBridge, /type: "bridge-ready"/);
assert.match(contentBridge, /\[a-z\]\{3\}-\[a-z\]\{4\}-\[a-z\]\{3\}/);
assert.doesNotMatch(contentBridge, /connectNative|native-request/);

let pageListener;
let extensionListener;
const extensionMessages = [];
const pageMessages = [];
const pageLocation = new URL("https://meet.google.com/abc-defg-hij");
const pageWorld = {
  location: pageLocation,
  chrome: {
    runtime: {
      connect: () => ({
        onMessage: { addListener: (listener) => { extensionListener = listener; } },
        onDisconnect: { addListener: () => {} },
        postMessage: (message) => extensionMessages.push(message),
        disconnect: () => {},
      }),
    },
  },
};
pageWorld.window = pageWorld;
pageWorld.addEventListener = (_type, listener) => { pageListener = listener; };
pageWorld.postMessage = (message) => pageMessages.push(message);
const pageContext = vm.createContext(pageWorld);
vm.runInContext(contentBridge, pageContext);
assert.equal(pageMessages[0]?.type, "bridge-ready");
pageListener({
  source: vm.runInContext("window", pageContext),
  origin: pageLocation.origin,
  data: {
    channel: WEBRTC_LOOPBACK_CHANNEL,
    direction: "page-to-extension",
    type: "register",
    role: "meeting",
  },
});
assert.equal(extensionMessages[0]?.type, "register");
assert.equal(extensionMessages[0]?.role, "meeting");
extensionListener({ type: "peer-ready" });
assert.equal(pageMessages.at(-1)?.type, "peer-ready");

process.stdout.write("WebRTC loopback contracts and hook wiring passed.\n");
