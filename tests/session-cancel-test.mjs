#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformAdapter } from "../src/platform/platform-registry.mjs";

const platform = getPlatformAdapter();
const { spawn } = platform.process;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDir = mkdtempSync(resolve(tmpdir(), "meeting-copilot-cancel-test-"));
const runtimeDir = resolve(temporaryDir, "runtime");
const helperPath = resolve(temporaryDir, "meeting-start-job.mjs");
writeFileSync(helperPath, "setInterval(() => {}, 1000);\n");

const launch = spawn(process.execPath, [helperPath], {
  detached: true,
  stdio: "ignore",
});
launch.unref();
writeFileSync(
  resolve(temporaryDir, "meeting-launch.json"),
  JSON.stringify({
    status: "running",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    pid: launch.pid,
    startedAt: new Date().toISOString(),
  }),
);

// Move the state into the runtime directory after the helper exists so the host
// can never observe a partial launch record.
await import("node:fs/promises").then(async ({ mkdir, rename }) => {
  await mkdir(runtimeDir, { recursive: true });
  await rename(resolve(temporaryDir, "meeting-launch.json"), resolve(runtimeDir, "meeting-launch.json"));
});

const host = spawn(
  process.execPath,
  [
    resolve(repoRoot, "scripts/native-host.mjs"),
    "chrome-extension://jlikakgdldiihhflkobhnpfegjlcakdd/",
  ],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      MEETING_COPILOT_RUNTIME_DIR: runtimeDir,
      MEETING_COPILOT_CDP_PORT: "65534",
      MEETING_COPILOT_SWITCH_AUDIO_SOURCE: "/usr/bin/true",
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

function frame(message) {
  const request = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(request.length, 0);
  return Buffer.concat([header, request]);
}

let output = Buffer.alloc(0);
const response = await new Promise((resolveResponse, reject) => {
  const timeout = setTimeout(() => reject(new Error("Session cancellation timed out.")), 20_000);
  host.stdout.on("data", (chunk) => {
    output = Buffer.concat([output, chunk]);
    if (output.length < 4) return;
    const length = output.readUInt32LE(0);
    if (output.length < length + 4) return;
    clearTimeout(timeout);
    resolveResponse(JSON.parse(output.subarray(4, length + 4).toString("utf8")));
  });
  host.once("error", reject);
  host.stderr.on("data", (chunk) => process.stderr.write(chunk));
  host.stdin.end(frame({ id: "test-stop", type: "session.stop" }));
});

host.kill();
await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
let launchStillRunning = true;
try {
  if (!platform.process.exists(launch.pid)) throw new Error("Launch process exited early");
} catch {
  launchStillRunning = false;
}

try {
  if (
    response.ok !== true ||
    response.data?.stopped !== true ||
    response.data?.launchCancellation?.cancelled !== true ||
    launchStillRunning
  ) {
    throw new Error(`Unexpected cancellation result: ${JSON.stringify({ response, launchStillRunning })}`);
  }
} finally {
  try {
    platform.process.terminateTree(launch.pid, "SIGKILL");
  } catch {}
  rmSync(temporaryDir, { recursive: true, force: true });
}

process.stdout.write("Session stop cancels an in-progress meeting launch.\n");
