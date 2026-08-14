#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDir = mkdtempSync(resolve(tmpdir(), "meeting-copilot-native-test-"));
const profileDir = resolve(temporaryDir, "profile");
mkdirSync(resolve(profileDir, "Default"), { recursive: true });
writeFileSync(
  resolve(profileDir, "Default/Secure Preferences"),
  JSON.stringify({
    extensions: {
      settings: {
        jlikakgdldiihhflkobhnpfegjlcakdd: {
          location: 4,
          path: resolve(repoRoot, "extension"),
        },
      },
    },
  }),
);
const child = spawn(
  process.execPath,
  [
    resolve(repoRoot, "scripts/native-host.mjs"),
    "chrome-extension://jlikakgdldiihhflkobhnpfegjlcakdd/",
  ],
  {
  cwd: repoRoot,
  env: { ...process.env, MEETING_COPILOT_PROFILE_DIR: profileDir },
  stdio: ["pipe", "pipe", "pipe"],
  },
);

function frame(message) {
  const request = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(request.length, 0);
  return Buffer.concat([header, request]);
}

child.stdin.write(Buffer.concat([
  frame({ id: "test-ping", type: "ping" }),
  frame({ id: "test-invalid-url", type: "meeting.start", payload: { meetingUrl: "https://example.com/not-meet" } }),
  frame({ id: "test-invalid-project", type: "setup.project.save", payload: { projectUrl: "https://example.com/project" } }),
  frame({ id: "test-invalid-confirmation", type: "setup.confirm", payload: { step: "unknown", complete: true } }),
  frame({ id: "test-setup-status", type: "setup.status" }),
]));

const timeout = setTimeout(() => {
  child.kill();
  process.stderr.write("Native Host ping timed out.\n");
  process.exit(1);
}, 10_000);

let output = Buffer.alloc(0);
const responses = [];
child.stdout.on("data", (chunk) => {
  output = Buffer.concat([output, chunk]);
  while (output.length >= 4) {
    const length = output.readUInt32LE(0);
    if (output.length < length + 4) {
      break;
    }
    responses.push(JSON.parse(output.subarray(4, length + 4).toString("utf8")));
    output = output.subarray(length + 4);
  }

  if (responses.length < 5) {
    return;
  }
  clearTimeout(timeout);
  child.kill();
  const ping = responses.find((response) => response.id === "test-ping");
  const invalidUrl = responses.find((response) => response.id === "test-invalid-url");
  const invalidProject = responses.find((response) => response.id === "test-invalid-project");
  const invalidConfirmation = responses.find((response) => response.id === "test-invalid-confirmation");
  const setupStatus = responses.find((response) => response.id === "test-setup-status");
  if (
    ping?.ok !== true ||
    ping.data?.pong !== true ||
    ping.data?.extensionId !== "jlikakgdldiihhflkobhnpfegjlcakdd" ||
    invalidUrl?.ok !== false ||
    !invalidUrl.error?.includes("meet.google.com") ||
    invalidProject?.ok !== false ||
    !invalidProject.error?.includes("ChatGPT Project") ||
    invalidConfirmation?.ok !== false ||
    setupStatus?.ok !== true ||
    setupStatus.data?.dedicatedChrome?.extensionInstalled !== true ||
    setupStatus.data?.dedicatedChrome?.sharedProfile !== true ||
    setupStatus.data?.confirmations?.profileLayoutVersion !== 2
  ) {
    rmSync(temporaryDir, { recursive: true, force: true });
    process.stderr.write(`Unexpected Native Host responses: ${JSON.stringify(responses)}\n`);
    process.exit(1);
  }
  rmSync(temporaryDir, { recursive: true, force: true });
  process.stdout.write("Native Host protocol and setup validation passed.\n");
});

child.stderr.on("data", (chunk) => process.stderr.write(chunk));
