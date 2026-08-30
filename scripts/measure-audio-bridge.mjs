#!/usr/bin/env node

import { existsSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { chromium } from "playwright-core";
import { getPlatformAdapter } from "../src/platform/platform-registry.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
};
if (args.includes("--help")) {
  process.stdout.write(`Usage:
  node scripts/measure-audio-bridge.mjs --mode webrtc-loopback [--headful]
  node scripts/measure-audio-bridge.mjs --mode cable --output-device NAME --input-device NAME [--headless]

The cable direction must pair an output endpoint with its matching input endpoint.
For VB-CABLE B, use CABLE-B Input as output and CABLE-B Output as input.
`);
  process.exit(0);
}

const mode = value("--mode") || "webrtc-loopback";
if (mode === "webrtc-loopback") {
  if (args.includes("--headful")) {
    process.env.MEETRON_AUDIO_MEASUREMENT_HEADFUL = "1";
  }
  await import("../tests/webrtc-loopback-browser-test.mjs");
  process.exit(0);
}
if (mode !== "cable") throw new Error(`Unsupported measurement mode: ${mode}`);

const outputDeviceName = value("--output-device");
const inputDeviceName = value("--input-device");
if (!outputDeviceName || !inputDeviceName) {
  throw new Error("Cable measurement requires --output-device and --input-device.");
}

const platform = getPlatformAdapter();
const chromeApplication = platform.chrome
  .applications({ home: process.env.HOME || homedir(), env: process.env })
  .find((candidate) => existsSync(candidate));
if (!chromeApplication) throw new Error("Google Chrome was not found.");

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Meetron cable measurement</title>");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: platform.chrome.executable(chromeApplication),
  headless: args.includes("--headless"),
  ignoreDefaultArgs: ["--mute-audio"],
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
});

try {
  const context = await browser.newContext();
  await context.grantPermissions(["microphone"], { origin });
  const page = await context.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async ({ outputName, inputName }) => {
    await navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => stream.getTracks().forEach((track) => track.stop()));
    const devices = await navigator.mediaDevices.enumerateDevices();
    const normalize = (entry) => entry.trim().toLowerCase();
    const output = devices.find((device) =>
      device.kind === "audiooutput" && normalize(device.label).startsWith(normalize(outputName)));
    const input = devices.find((device) =>
      device.kind === "audioinput" && normalize(device.label).startsWith(normalize(inputName)));
    if (!output || !input) {
      throw new Error(`Required endpoints were not found (output=${Boolean(output)}, input=${Boolean(input)}).`);
    }
    const inputStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: input.deviceId },
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      },
    });
    const inputContext = new AudioContext({ latencyHint: "interactive" });
    const analyser = inputContext.createAnalyser();
    analyser.fftSize = 4096;
    inputContext.createMediaStreamSource(inputStream).connect(analyser);
    const outputContext = new AudioContext({ latencyHint: "interactive", sinkId: output.deviceId });
    if (outputContext.sinkId !== output.deviceId && typeof outputContext.setSinkId === "function") {
      await outputContext.setSinkId(output.deviceId);
    }
    const oscillator = outputContext.createOscillator();
    oscillator.frequency.value = 997;
    const gain = outputContext.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(outputContext.destination);
    await Promise.all([inputContext.resume(), outputContext.resume()]);
    oscillator.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const startedAt = performance.now();
    gain.gain.setValueAtTime(0.5, outputContext.currentTime);
    let latencyMs = null;
    let rms = 0;
    let peakFrequency = 0;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const timeValues = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(timeValues);
      rms = Math.sqrt(timeValues.reduce((sum, sample) => sum + sample * sample, 0) / timeValues.length);
      if (rms > 0.02) {
        latencyMs = performance.now() - startedAt;
        const frequencyValues = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(frequencyValues);
        let maximum = -Infinity;
        let maximumIndex = 0;
        for (let index = 1; index < frequencyValues.length; index += 1) {
          if (frequencyValues[index] > maximum) {
            maximum = frequencyValues[index];
            maximumIndex = index;
          }
        }
        peakFrequency = maximumIndex * inputContext.sampleRate / analyser.fftSize;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    inputStream.getTracks().forEach((track) => track.stop());
    await Promise.all([inputContext.close(), outputContext.close()]);
    return {
      mode: "cable",
      outputDevice: output.label,
      inputDevice: input.label,
      latencyMs,
      rms,
      rmsDbfs: rms > 0 ? 20 * Math.log10(rms) : null,
      expectedFrequencyHz: 997,
      peakFrequencyHz: peakFrequency,
      frequencyErrorPercent: peakFrequency ? Math.abs(peakFrequency - 997) / 997 * 100 : null,
    };
  }, { outputName: outputDeviceName, inputName: inputDeviceName });
  if (result.latencyMs === null) throw new Error(`Cable produced no measurable signal: ${JSON.stringify(result)}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
