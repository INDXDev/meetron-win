#!/usr/bin/env node

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { defineAudioBackend } from "../src/audio/audio-backend-contract.mjs";
import { getPlatformAdapter } from "../src/platform/platform-registry.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(repoRoot, ".meeting-copilot.env");
const platform = getPlatformAdapter();

export function createAudioBackends({ labelPrefix = "Meetron: " } = {}) {
  if (typeof labelPrefix !== "string" || !labelPrefix.trim()) {
    throw new Error("Audio device label prefix must be a non-empty string.");
  }
  return Object.freeze({
    custom: defineAudioBackend({
      id: "custom",
      label: "Meetron Audio",
      meetingToAI: {
        name: `${labelPrefix}Meeting to AI`,
        uid: "io.github.bb8ad8.meetron.audio.meeting-to-ai.device",
      },
      aiToMeeting: {
        name: `${labelPrefix}AI to Meeting`,
        uid: "io.github.bb8ad8.meetron.audio.ai-to-meeting.device",
      },
    }),
    legacyCustom: defineAudioBackend({
      id: "legacy-custom",
      label: "Meeting Copilot Audio (legacy)",
      meetingToAI: {
        name: "Meeting Copilot: Meeting to AI",
        uid: "dev.meetingcopilot.audio.meeting-to-ai.device",
      },
      aiToMeeting: {
        name: "Meeting Copilot: AI to Meeting",
        uid: "dev.meetingcopilot.audio.ai-to-meeting.device",
      },
    }),
    blackhole: defineAudioBackend({
      id: "blackhole",
      label: "BlackHole (legacy)",
      meetingToAI: { name: "BlackHole 2ch", uid: "BlackHole2ch_UID" },
      aiToMeeting: { name: "BlackHole 16ch", uid: "BlackHole16ch_UID" },
    }),
    vbCable: defineAudioBackend({
      id: "vb-cable",
      label: "VB-CABLE A+B",
      meetingToAI: { name: "CABLE-A Output (VB-Audio Cable A)" },
      aiToMeeting: { name: "CABLE-B Output (VB-Audio Cable B)" },
      routing: {
        chatgptInput: { name: "CABLE-A Output (VB-Audio Cable A)" },
        chatgptOutput: { name: "CABLE-B Input (VB-Audio Cable B)" },
        meetingMicrophone: { name: "CABLE-B Output (VB-Audio Cable B)" },
        meetingSpeaker: { name: "CABLE-A Input (VB-Audio Cable A)" },
      },
    }),
    webrtcLoopback: defineAudioBackend({
      id: "webrtc-loopback",
      label: "Driverless WebRTC loopback (experimental)",
      transport: "webrtc-loopback",
      meetingToAI: { name: "Meetron WebRTC: Meeting to AI" },
      aiToMeeting: { name: "Meetron WebRTC: AI to Meeting" },
    }),
  });
}

function configuredAudioLabelPrefix() {
  // A blank prefix must fall back to the default: this runs while the module is
  // being imported, so throwing here would break every command that reads audio
  // status, including the restore path used by uninstall.
  if (process.env.MEETING_COPILOT_AUDIO_LABEL_PREFIX?.trim()) {
    return process.env.MEETING_COPILOT_AUDIO_LABEL_PREFIX;
  }
  if (existsSync(envPath)) {
    const match = readFileSync(envPath, "utf8").match(
      /^MEETING_COPILOT_AUDIO_LABEL_PREFIX=['"]?([^'"\r\n]+)['"]?$/m,
    );
    if (match?.[1]?.trim()) return match[1];
  }
  return "Meetron: ";
}

export const AUDIO_BACKENDS = createAudioBackends({
  labelPrefix: configuredAudioLabelPrefix(),
});

function configuredBackendPreference() {
  if (process.env.MEETING_COPILOT_AUDIO_BACKEND) {
    return process.env.MEETING_COPILOT_AUDIO_BACKEND;
  }
  if (existsSync(envPath)) {
    const match = readFileSync(envPath, "utf8").match(
      /^MEETING_COPILOT_AUDIO_BACKEND=['"]?([^'"\r\n]+)['"]?$/m,
    );
    if (match) return match[1];
  }
  return "auto";
}

export function selectAudioBackend(devices, requested = configuredBackendPreference()) {
  if (!["auto", "custom", "legacy-custom", "blackhole", "vb-cable", "webrtc-loopback"].includes(requested)) {
    throw new Error(`Unsupported audio backend: ${requested}`);
  }
  const available = (backend) => requiredTargets(backend)
    .every((required) => resolveDeviceTarget(devices, required));
  if (requested === "legacy-custom") return AUDIO_BACKENDS.legacyCustom;
  if (requested === "vb-cable") return AUDIO_BACKENDS.vbCable;
  if (requested === "webrtc-loopback") return AUDIO_BACKENDS.webrtcLoopback;
  if (requested !== "auto") return AUDIO_BACKENDS[requested];
  if (available(AUDIO_BACKENDS.custom)) return AUDIO_BACKENDS.custom;
  if (available(AUDIO_BACKENDS.legacyCustom)) return AUDIO_BACKENDS.legacyCustom;
  if (available(AUDIO_BACKENDS.blackhole)) return AUDIO_BACKENDS.blackhole;
  if (available(AUDIO_BACKENDS.vbCable)) return AUDIO_BACKENDS.vbCable;
  return platform.id === "win32" ? AUDIO_BACKENDS.vbCable : AUDIO_BACKENDS.custom;
}

export function routingForBackend(backend) {
  return backend.routing;
}

function requiredTargets(backend) {
  if (backend.transport === "webrtc-loopback") return [];
  const seen = new Set();
  return Object.values(routingForBackend(backend)).filter((target) => {
    const key = `${target.uid}\0${target.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function driverlessStatus() {
  const backend = AUDIO_BACKENDS.webrtcLoopback;
  return {
    ready: true,
    devicesReady: true,
    controller: "browser",
    backend: backend.id,
    backendLabel: backend.label,
    transport: backend.transport,
    input: "",
    output: "",
    inputUID: "",
    outputUID: "",
    devices: [],
    deviceDetails: [],
    requiredDevices: {},
    requiredDeviceNames: [],
    routing: routingForBackend(backend),
    systemDefaultsUnchanged: true,
    audioControlInstalled: false,
    switchAudioSourceInstalled: false,
    experimental: true,
  };
}

function audioControlExecutable() {
  const candidates = platform.audioControl.executableCandidates({ repoRoot, env: process.env });
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function switchAudioSourceExecutable() {
  const candidates = platform.audioControl.fallbackExecutableCandidates({ env: process.env });
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

async function systemStatus() {
  const audioctl = audioControlExecutable();
  if (audioctl) {
    const { stdout } = await platform.process.run(audioctl, ["status"], { timeout: 10_000 });
    return {
      ...JSON.parse(stdout),
      controller: platform.audioControl.controller || "coreaudio",
      executable: audioctl,
    };
  }
  const switchAudioSource = switchAudioSourceExecutable();
  if (!switchAudioSource) {
    return { input: null, output: null, devices: [], controller: "unavailable" };
  }
  const [input, output, allDevices] = await Promise.all([
    platform.process.run(switchAudioSource, ["-c", "-t", "input"], { timeout: 10_000 }),
    platform.process.run(switchAudioSource, ["-c", "-t", "output"], { timeout: 10_000 }),
    platform.process.run(switchAudioSource, ["-a"], { timeout: 10_000 }),
  ]);
  const names = allDevices.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
  const device = (name) => ({ id: 0, uid: "", name, hasInput: true, hasOutput: true });
  return {
    input: device(input.stdout.trim()),
    output: device(output.stdout.trim()),
    devices: names.map(device),
    controller: "switchaudio-osx",
    executable: switchAudioSource,
  };
}

export function resolveDeviceTarget(devices, target) {
  if (target.uid) {
    const uidMatch = devices.find((device) => device.uid === target.uid);
    if (uidMatch) return uidMatch;
    if (devices.some((device) => device.uid)) return undefined;
  }
  return devices.find((device) => device.name === target.name);
}

function hasDevice(devices, target) {
  return Boolean(resolveDeviceTarget(devices, target));
}

function isDevice(device, target) {
  if (!device) return false;
  if (target.uid && device.uid) return device.uid === target.uid;
  return device.name === target.name;
}

export async function getAudioStatus() {
  if (configuredBackendPreference() === "webrtc-loopback") return driverlessStatus();
  try {
    const system = await systemStatus();
    const backend = selectAudioBackend(system.devices);
    const routing = routingForBackend(backend);
    const required = requiredTargets(backend);
    const devicesReady = required.every((target) => hasDevice(system.devices, target));
    return {
      ready: devicesReady,
      devicesReady,
      controller: system.controller,
      backend: backend.id,
      backendLabel: backend.label,
      transport: backend.transport,
      input: system.input?.name || "",
      output: system.output?.name || "",
      inputUID: system.input?.uid || "",
      outputUID: system.output?.uid || "",
      devices: system.devices.map((device) => device.name),
      deviceDetails: system.devices,
      requiredDevices: Object.fromEntries(required.map((target) => [target.name, hasDevice(system.devices, target)])),
      requiredDeviceNames: required.map((target) => target.name),
      routing,
      systemDefaultsUnchanged: true,
      inputMatchesLegacyRoute: isDevice(system.input, routing.chatgptInput),
      audioControlInstalled: ["coreaudio", "mmdevice"].includes(system.controller),
      switchAudioSourceInstalled: system.controller === "switchaudio-osx",
    };
  } catch (error) {
    const fallback = platform.id === "win32" ? AUDIO_BACKENDS.vbCable : AUDIO_BACKENDS.custom;
    const required = requiredTargets(fallback);
    return {
      ready: false,
      devicesReady: false,
      controller: "error",
      backend: fallback.id,
      backendLabel: fallback.label,
      input: "",
      output: "",
      devices: [],
      requiredDevices: Object.fromEntries(required.map((target) => [target.name, false])),
      requiredDeviceNames: required.map((target) => target.name),
      routing: routingForBackend(fallback),
      error: error.message,
    };
  }
}

async function setDefault(kind, target, system) {
  if (["coreaudio", "mmdevice"].includes(system.controller)) {
    const resolvedTarget = resolveDeviceTarget(system.devices, target);
    if (!resolvedTarget?.uid) throw new Error(`Audio device UID was not found: ${target.name}`);
    await platform.process.run(system.executable, [`set-default-${kind}`, "--uid", resolvedTarget.uid], { timeout: 10_000 });
  } else if (system.controller === "switchaudio-osx") {
    await platform.process.run(system.executable, ["-t", kind, "-s", target.name], { timeout: 10_000 });
  } else {
    throw new Error("No supported audio controller is available. Build the platform audio control helper first.");
  }
}

function runtimeStatePath() {
  const runtimeDir = platform.paths.resolve({
    repoRoot,
    home: process.env.HOME || homedir(),
    env: process.env,
  }).runtimeDir;
  return { runtimeDir, statePath: resolve(runtimeDir, "audio-original.json") };
}

export async function configureAudio({ dryRun = false } = {}) {
  if (configuredBackendPreference() === "webrtc-loopback") {
    return { ...driverlessStatus(), dryRun, restorable: false };
  }
  const { statePath } = runtimeStatePath();
  const legacyRestorePending = existsSync(statePath);
  const legacyRestore = legacyRestorePending && !dryRun
    ? await restoreAudio()
    : { restored: false, alreadyRestored: !legacyRestorePending };
  const system = await systemStatus();
  const backend = selectAudioBackend(system.devices);
  const routing = routingForBackend(backend);
  const required = requiredTargets(backend);
  const missing = required.filter((target) => !hasDevice(system.devices, target));
  if (missing.length) throw new Error(`Required audio device was not found: ${missing.map((item) => item.name).join(", ")}`);
  if (dryRun) {
    return {
      dryRun: true,
      backend: backend.id,
      input: system.input?.name || "",
      output: system.output?.name || "",
      legacyRestorePending,
      systemDefaultsUnchanged: true,
    };
  }
  return {
    ready: true,
    backend: backend.id,
    input: system.input?.name || "",
    inputUID: system.input?.uid || "",
    output: system.output?.name || "",
    outputUID: system.output?.uid || "",
    inputUnchanged: true,
    outputUnchanged: true,
    systemDefaultsUnchanged: true,
    restorable: false,
    legacyRestore,
    routing,
  };
}

export async function restoreAudio({ dryRun = false } = {}) {
  const { statePath } = runtimeStatePath();
  if (!existsSync(statePath)) return { restored: false, alreadyRestored: true };
  const saved = JSON.parse(readFileSync(statePath, "utf8"));
  const system = await systemStatus();
  const input = { name: saved.input, uid: saved.inputUID || "" };
  const output = { name: saved.output, uid: saved.outputUID || "" };
  if (!input.name) throw new Error("The saved input device is invalid.");
  if (!hasDevice(system.devices, input)) throw new Error(`The original audio device is no longer available: ${input.name}`);
  if (saved.outputChanged !== false && !hasDevice(system.devices, output)) {
    throw new Error(`The original audio device is no longer available: ${output.name}`);
  }
  if (dryRun) return { dryRun: true, input: input.name, output: output.name, outputRestored: saved.outputChanged !== false };
  await setDefault("input", input, system);
  if (saved.outputChanged !== false) await setDefault("output", output, system);
  const resolved = await systemStatus();
  if (!isDevice(resolved.input, input) || (saved.outputChanged !== false && !isDevice(resolved.output, output))) {
    throw new Error("The original audio routing could not be verified.");
  }
  unlinkSync(statePath);
  return {
    restored: true,
    input: resolved.input.name,
    output: resolved.output?.name || "",
    outputRestored: saved.outputChanged !== false,
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (["-h", "--help"].includes(command)) {
    process.stdout.write("Usage: node scripts/audio-backend.mjs <status|configure|restore> [--dry-run]\n");
    return;
  }
  const dryRun = args.includes("--dry-run");
  let result;
  if (command === "status") result = await getAudioStatus();
  else if (command === "configure") result = await configureAudio({ dryRun });
  else if (command === "restore") result = await restoreAudio({ dryRun });
  else throw new Error("Expected status, configure, or restore command.");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
