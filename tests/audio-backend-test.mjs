#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  AUDIO_BACKENDS,
  createAudioBackends,
  configureAudio,
  getAudioStatus,
  resolveDeviceTarget,
  routingForBackend,
  selectAudioBackend,
} from "../scripts/audio-backend.mjs";

const customDevices = [
  { name: AUDIO_BACKENDS.custom.meetingToAI.name, uid: AUDIO_BACKENDS.custom.meetingToAI.uid },
  { name: AUDIO_BACKENDS.custom.aiToMeeting.name, uid: AUDIO_BACKENDS.custom.aiToMeeting.uid },
];
const blackHoleDevices = [
  { name: AUDIO_BACKENDS.blackhole.meetingToAI.name, uid: AUDIO_BACKENDS.blackhole.meetingToAI.uid },
  { name: AUDIO_BACKENDS.blackhole.aiToMeeting.name, uid: AUDIO_BACKENDS.blackhole.aiToMeeting.uid },
];
const legacyCustomDevices = [
  { name: AUDIO_BACKENDS.legacyCustom.meetingToAI.name, uid: AUDIO_BACKENDS.legacyCustom.meetingToAI.uid },
  { name: AUDIO_BACKENDS.legacyCustom.aiToMeeting.name, uid: AUDIO_BACKENDS.legacyCustom.aiToMeeting.uid },
];
const vbCableDevices = Object.values(AUDIO_BACKENDS.vbCable.routing);

assert.equal(selectAudioBackend([...blackHoleDevices, ...customDevices], "auto").id, "custom");
assert.equal(selectAudioBackend([...blackHoleDevices, ...legacyCustomDevices], "auto").id, "legacy-custom");
assert.equal(selectAudioBackend(blackHoleDevices, "auto").id, "blackhole");
assert.equal(selectAudioBackend(vbCableDevices, "auto").id, "vb-cable");
assert.equal(selectAudioBackend([], "vb-cable").id, "vb-cable");
assert.equal(selectAudioBackend([], "custom").id, "custom");
assert.equal(selectAudioBackend([], "webrtc-loopback").id, "webrtc-loopback");
assert.equal(AUDIO_BACKENDS.webrtcLoopback.transport, "webrtc-loopback");
assert.equal(selectAudioBackend([], "auto").id === "webrtc-loopback", false);
const originalBackend = process.env.MEETING_COPILOT_AUDIO_BACKEND;
process.env.MEETING_COPILOT_AUDIO_BACKEND = "webrtc-loopback";
try {
  const status = await getAudioStatus();
  assert.equal(status.ready, true);
  assert.equal(status.controller, "browser");
  assert.deepEqual(status.requiredDeviceNames, []);
  assert.equal(status.systemDefaultsUnchanged, true);
  const configured = await configureAudio();
  assert.equal(configured.backend, "webrtc-loopback");
  assert.equal(configured.restorable, false);
} finally {
  if (originalBackend === undefined) delete process.env.MEETING_COPILOT_AUDIO_BACKEND;
  else process.env.MEETING_COPILOT_AUDIO_BACKEND = originalBackend;
}
assert.equal(resolveDeviceTarget(customDevices, {
  name: AUDIO_BACKENDS.custom.meetingToAI.name,
  uid: "wrong.uid",
}), undefined);
assert.equal(resolveDeviceTarget(customDevices, {
  name: AUDIO_BACKENDS.custom.meetingToAI.name,
  uid: "",
})?.uid, AUDIO_BACKENDS.custom.meetingToAI.uid);

const routing = routingForBackend(AUDIO_BACKENDS.custom);
assert.equal(routing.chatgptInput.uid, routing.meetingSpeaker.uid);
assert.equal(routing.chatgptOutput.uid, routing.meetingMicrophone.uid);
assert.notEqual(routing.chatgptInput.uid, routing.chatgptOutput.uid);

const vbRouting = routingForBackend(AUDIO_BACKENDS.vbCable);
assert.match(vbRouting.meetingSpeaker.name, /CABLE-A Input/);
assert.match(vbRouting.chatgptInput.name, /CABLE-A Output/);
assert.match(vbRouting.chatgptOutput.name, /CABLE-B Input/);
assert.match(vbRouting.meetingMicrophone.name, /CABLE-B Output/);

const branded = createAudioBackends({ labelPrefix: "Contoso Cable - " });
assert.equal(branded.custom.meetingToAI.name, "Contoso Cable - Meeting to AI");
assert.equal(branded.custom.aiToMeeting.name, "Contoso Cable - AI to Meeting");

process.stdout.write("Audio backend selection passed.\n");
