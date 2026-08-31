#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { getPlatformAdapter } from "../src/platform/platform-registry.mjs";
import { installWebRtcLoopbackPage } from "../src/audio/webrtc-loopback-page.mjs";

const platform = getPlatformAdapter();
const measurementHeadless = process.env.MEETRON_AUDIO_MEASUREMENT_HEADFUL !== "1";
const chromeApplication = platform.chrome
  .applications({ home: process.env.HOME || homedir(), env: process.env })
  .find((candidate) => existsSync(candidate));
if (!chromeApplication) {
  process.stdout.write("WebRTC loopback browser test skipped: Google Chrome was not found.\n");
  process.exit(0);
}

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Meetron WebRTC loopback fixture</title><body></body>");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const audioFixtureDir = await mkdtemp(resolve(tmpdir(), "meetron-webrtc-audio-"));
const audioFixturePath = resolve(audioFixtureDir, "tone.wav");
const sampleRate = 48_000;
const sampleCount = sampleRate * 5;
const wave = Buffer.alloc(44 + sampleCount * 2);
wave.write("RIFF", 0);
wave.writeUInt32LE(36 + sampleCount * 2, 4);
wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(sampleRate, 24);
wave.writeUInt32LE(sampleRate * 2, 28);
wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34);
wave.write("data", 36);
wave.writeUInt32LE(sampleCount * 2, 40);
for (let index = 0; index < sampleCount; index += 1) {
  wave.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 997 * index / sampleRate) * 16_000), 44 + index * 2);
}
await writeFile(audioFixturePath, wave);

const browser = await chromium.launch({
  executablePath: platform.chrome.executable(chromeApplication),
  headless: measurementHeadless,
  ignoreDefaultArgs: ["--mute-audio"],
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${audioFixturePath}`,
  ],
});
try {
  const context = await browser.newContext();
  const control = await context.newPage();
  await control.goto(`${origin}/control`);
  const directControlDecibels = await control.evaluate(async () => {
    const sourceContext = new AudioContext();
    const destination = sourceContext.createMediaStreamDestination();
    const oscillator = sourceContext.createOscillator();
    oscillator.frequency.value = 997;
    oscillator.connect(destination);
    const receiverContext = new AudioContext();
    const analyser = receiverContext.createAnalyser();
    analyser.fftSize = 4096;
    receiverContext.createMediaStreamSource(destination.stream).connect(analyser);
    await Promise.all([sourceContext.resume(), receiverContext.resume()]);
    oscillator.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const values = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(values);
    const maximum = Math.max(...values);
    return Number.isFinite(maximum) ? maximum : null;
  });
  const directWebRtcControl = await control.evaluate(async () => {
    const source = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
    });
    const sender = new RTCPeerConnection({ iceServers: [] });
    const receiver = new RTCPeerConnection({ iceServers: [] });
    sender.onicecandidate = (event) => {
      if (event.candidate) void receiver.addIceCandidate(event.candidate);
    };
    receiver.onicecandidate = (event) => {
      if (event.candidate) void sender.addIceCandidate(event.candidate);
    };
    const received = new Promise((resolve) => {
      receiver.ontrack = (event) => resolve(event.track);
    });
    sender.addTrack(source.getAudioTracks()[0], source);
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
    const track = await received;
    // Chrome decodes a remote track only while its stream also has a media
    // element sink. Without one this control measured silence, which flipped
    // browserControlCarriesAudio off and skipped every assertion below.
    const remoteStream = new MediaStream([track]);
    const sink = new Audio();
    sink.muted = true;
    sink.autoplay = true;
    sink.srcObject = remoteStream;
    await sink.play().catch(() => {});
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 4096;
    context.createMediaStreamSource(remoteStream).connect(analyser);
    await context.resume();
    let maximum = -Infinity;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const values = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(values);
      maximum = Math.max(...values);
      if (maximum > -45) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stats = [...(await receiver.getStats()).values()]
      .find((entry) => entry.type === "inbound-rtp" && entry.kind === "audio");
    sender.close();
    receiver.close();
    return {
      decibels: Number.isFinite(maximum) ? maximum : null,
      bytesReceived: stats?.bytesReceived || 0,
      audioLevel: stats?.audioLevel || 0,
    };
  });
  await control.close();
  assert.ok(directWebRtcControl.bytesReceived > 0, JSON.stringify(directWebRtcControl));
  const pages = new Map();
  const registrations = new Set();
  const relayedSignals = [];

  async function addPeer(role) {
    const page = await context.newPage();
    pages.set(role, page);
    await page.exposeFunction("__meetronTestRelay", async (message) => {
      if (message.type === "register") {
        registrations.add(role);
        return;
      }
      if (message.type !== "signal") return;
      relayedSignals.push(role);
      const counterpart = pages.get(role === "chatgpt" ? "meeting" : "chatgpt");
      void counterpart?.evaluate(({ description, candidate }) => {
        window.postMessage({
          channel: "meetron-webrtc-loopback",
          direction: "extension-to-page",
          type: "signal",
          description,
          candidate,
        }, location.origin);
      }, message).catch(() => {});
    });
    await page.addInitScript(() => {
      globalThis.__meetronTestNativeGetUserMedia =
        globalThis.MediaDevices?.prototype?.getUserMedia;
      window.addEventListener("message", (event) => {
        if (
          event.source === window &&
          event.origin === location.origin &&
          event.data?.channel === "meetron-webrtc-loopback" &&
          event.data?.direction === "page-to-extension"
        ) void window.__meetronTestRelay(event.data);
      });
    });
    await page.addInitScript(installWebRtcLoopbackPage, { role });
    await page.goto(`${origin}/${role}`);
    return page;
  }

  const chatgpt = await addPeer("chatgpt");
  let meeting = await addPeer("meeting");
  for (let attempt = 0; attempt < 100 && registrations.size < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(registrations.size, 2);
  await Promise.all([...pages.values()].map((candidate) => candidate.evaluate(() => {
    window.postMessage({
      channel: "meetron-webrtc-loopback",
      direction: "extension-to-page",
      type: "peer-ready",
    }, location.origin);
  })));
  try {
    await Promise.all([chatgpt, meeting].map((page) => page.waitForFunction(() =>
      ["connected", "completed"].includes(globalThis.__meetronWebRtcLoopback?.iceConnectionState),
    undefined, { timeout: 15_000 })));
  } catch (error) {
    const diagnostics = await Promise.all([chatgpt, meeting].map((page) => page.evaluate(() => {
      const state = globalThis.__meetronWebRtcLoopback;
      return state && {
        role: state.role,
        connectionState: state.connectionState,
        iceConnectionState: state.iceConnectionState,
        signalMessages: state.signalMessages,
        peerReadyMessages: state.peerReadyMessages,
        offerAttempts: state.offerAttempts,
        signalingState: state.signalingState,
        failures: state.failures,
      };
    })));
    throw new Error(`WebRTC peers did not connect: ${JSON.stringify({ registrations: [...registrations], relayedSignals, diagnostics })}`, { cause: error });
  }

  async function sendToneAndMeasure(sender, receiver, frequency, outputMode) {
    await receiver.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
      });
      const context = new AudioContext({ latencyHint: "interactive" });
      const analyser = context.createAnalyser();
      analyser.fftSize = 4096;
      context.createMediaStreamSource(stream).connect(analyser);
      const directAnalyser = context.createAnalyser();
      directAnalyser.fftSize = 4096;
      const receivedTrack = globalThis.__meetronWebRtcLoopback.peerConnection
        .getReceivers().find((receiver) => receiver.track?.kind === "audio")?.track;
      if (receivedTrack) {
        const receivedStream = new MediaStream([receivedTrack]);
        context.createMediaStreamSource(receivedStream).connect(directAnalyser);
      }
      await context.resume();
      globalThis.__meetronToneReceiver = { analyser, directAnalyser, context, stream };
    });
    const startedAt = Date.now();
    await sender.evaluate(async (mode) => {
      const stream = await globalThis.__meetronTestNativeGetUserMedia.call(navigator.mediaDevices, {
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
        },
      });
      if (mode === "web-audio") {
        const context = new AudioContext({ latencyHint: "interactive" });
        const source = context.createMediaStreamSource(stream);
        source.connect(context.destination);
        await context.resume();
        globalThis.__meetronToneSender = { context, source, stream };
      } else {
        const audio = new Audio();
        audio.srcObject = stream;
        globalThis.__meetronToneSender = { audio, stream };
      }
    }, outputMode);
    await sender.waitForFunction(() =>
      globalThis.__meetronWebRtcLoopback.outputSources +
        globalThis.__meetronWebRtcLoopback.outputContexts > 0,
    undefined, { timeout: 5_000 });
    let sample;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      sample = await receiver.evaluate(() => {
        const { analyser, directAnalyser, context } = globalThis.__meetronToneReceiver;
        const values = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(values);
        const timeValues = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(timeValues);
        const directValues = new Float32Array(directAnalyser.frequencyBinCount);
        directAnalyser.getFloatFrequencyData(directValues);
        let maximum = -Infinity;
        let maximumIndex = 0;
        for (let index = 1; index < values.length; index += 1) {
          if (values[index] > maximum) {
            maximum = values[index];
            maximumIndex = index;
          }
        }
        return {
          decibels: maximum,
          directDecibels: Math.max(...directValues),
          frequency: maximumIndex * context.sampleRate / analyser.fftSize,
          rms: Math.sqrt(
            timeValues.reduce((total, value) => total + value * value, 0) / timeValues.length,
          ),
        };
      });
      if (sample.decibels > -45) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const localSenderSample = await sender.evaluate(async () => {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 4096;
      context.createMediaStreamSource(globalThis.__meetronWebRtcLoopback.activeOutputStream)
        .connect(analyser);
      await context.resume();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const values = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(values);
      const decibels = Math.max(...values);
      return Number.isFinite(decibels) ? decibels : null;
    });
    const diagnostics = await Promise.all([sender, receiver].map((page) => page.evaluate(async () => {
      const state = globalThis.__meetronWebRtcLoopback;
      const stats = [...(await state.peerConnection.getStats()).values()]
        .filter((entry) => ["inbound-rtp", "outbound-rtp"].includes(entry.type))
        .map((entry) => ({
          type: entry.type,
          kind: entry.kind,
          bytesReceived: entry.bytesReceived,
          bytesSent: entry.bytesSent,
          audioLevel: entry.audioLevel,
        }));
      return {
        role: state.role,
        bridgeContextState: state.bridgeContextState,
        outputSources: state.outputSources,
        outputContexts: state.outputContexts,
        signalMessages: state.signalMessages,
        signalingState: state.peerConnection.signalingState,
        failures: state.failures,
        activeOutputKind: state.activeOutputKind,
        activeTrack: state.activeOutputStream.getAudioTracks().map((track) => ({
          id: track.id,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
        })),
        senderTrack: state.peerConnection.getSenders().map((sender) => ({
          id: sender.track?.id,
          readyState: sender.track?.readyState,
        })),
        stats,
      };
    })));
    if (outputMode === "web-audio") {
      await sender.evaluate(() => {
        const { context, source } = globalThis.__meetronToneSender;
        source.disconnect(context.destination);
      });
    }
    return { ...sample, localSenderDecibels: localSenderSample, observedLatencyMs: Date.now() - startedAt, diagnostics };
  }

  const meetingToChatgpt = await sendToneAndMeasure(meeting, chatgpt, 997, "media-element");
  const chatgptToMeeting = await sendToneAndMeasure(chatgpt, meeting, 997, "web-audio");
  const browserControlCarriesAudio = directWebRtcControl.decibels !== null &&
    directWebRtcControl.decibels > -45;
  if (browserControlCarriesAudio) {
    assert.ok(Math.abs(meetingToChatgpt.frequency - 997) < 45, JSON.stringify(meetingToChatgpt));
    assert.ok(Math.abs(chatgptToMeeting.frequency - 997) < 45, JSON.stringify(chatgptToMeeting));
    assert.ok(meetingToChatgpt.observedLatencyMs < 1_000, JSON.stringify(meetingToChatgpt));
    assert.ok(chatgptToMeeting.observedLatencyMs < 1_000, JSON.stringify(chatgptToMeeting));
  } else {
    assert.equal(meetingToChatgpt.diagnostics[0].stats.some((entry) => entry.bytesSent > 0), true);
    assert.equal(chatgptToMeeting.diagnostics[0].stats.some((entry) => entry.bytesSent > 0), true);
  }

  const states = await Promise.all([chatgpt, meeting].map((page) => page.evaluate(() => {
    const state = globalThis.__meetronWebRtcLoopback;
    return {
      role: state.role,
      connectionState: state.connectionState,
      inputRequests: state.inputRequests,
      outputSources: state.outputSources,
      outputContexts: state.outputContexts,
      failures: state.failures,
      processing: state.processing,
    };
  })));
  for (const state of states) {
    assert.equal(state.failures.length, 0, JSON.stringify(state));
    assert.equal(state.inputRequests > 0, true, JSON.stringify(state));
    assert.equal(state.outputSources + state.outputContexts > 0, true, JSON.stringify(state));
    assert.deepEqual(state.processing, {
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
    });
  }

  await meeting.close();
  meeting = await addPeer("meeting");
  await Promise.all([chatgpt, meeting].map((page) => page.evaluate(() => {
    window.postMessage({
      channel: "meetron-webrtc-loopback",
      direction: "extension-to-page",
      type: "peer-ready",
    }, location.origin);
  })));
  await Promise.all([chatgpt, meeting].map((page) => page.waitForFunction(() =>
    ["connected", "completed"].includes(globalThis.__meetronWebRtcLoopback?.iceConnectionState),
  undefined, { timeout: 15_000 })));
  const summarizeDirection = ({ decibels, directDecibels, frequency, rms, observedLatencyMs, diagnostics }) => ({
    decibels: Number.isFinite(decibels) ? decibels : null,
    directDecibels: Number.isFinite(directDecibels) ? directDecibels : null,
    frequency: browserControlCarriesAudio ? frequency : null,
    frequencyErrorPercent: browserControlCarriesAudio
      ? Math.abs(frequency - 997) / 997 * 100
      : null,
    rms: browserControlCarriesAudio ? rms : null,
    rmsDbfs: browserControlCarriesAudio && rms > 0 ? 20 * Math.log10(rms) : null,
    observedLatencyMs: browserControlCarriesAudio ? observedLatencyMs : null,
    bytesSent: diagnostics[0].stats
      .filter((entry) => entry.type === "outbound-rtp")
      .reduce((total, entry) => total + (entry.bytesSent || 0), 0),
  });
  process.stdout.write(`${JSON.stringify({
    directControlDecibels,
    directWebRtcControl,
    measurementHeadless,
    browserControlCarriesAudio,
    peerReplacementConnected: true,
    meetingToChatgpt: summarizeDirection(meetingToChatgpt),
    chatgptToMeeting: summarizeDirection(chatgptToMeeting),
  })}\n`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(audioFixtureDir, { recursive: true, force: true });
}

process.stdout.write("Bidirectional WebRTC loopback browser integration passed.\n");
