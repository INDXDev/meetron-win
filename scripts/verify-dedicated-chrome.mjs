#!/usr/bin/env node

import { getPlatformAdapter } from "../src/platform/platform-registry.mjs";

const platform = getPlatformAdapter();
let profileDir = "";
let port = "";

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--profile-dir") profileDir = process.argv[++index] || "";
  else if (argument === "--port") port = process.argv[++index] || "";
  else if (argument === "--help" || argument === "-h") {
    process.stdout.write("Usage: node scripts/verify-dedicated-chrome.mjs --profile-dir DIR --port PORT\n");
    process.exit(0);
  } else {
    process.stderr.write(`Unknown option: ${argument}\n`);
    process.exit(2);
  }
}

if (!profileDir || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
  process.stderr.write("A dedicated profile directory and valid local port are required.\n");
  process.exit(2);
}

const expectedProfileArgument = `--user-data-dir=${profileDir} --no-first-run`;
const expectedPortArgument = `--remote-debugging-port=${port}`;
const chromePids = (await platform.chrome.profileProcesses(profileDir))
  .filter(
    (entry) =>
      entry.command.includes("--remote-debugging-address=127.0.0.1") &&
      entry.command.includes(expectedPortArgument) &&
      entry.command.includes(expectedProfileArgument),
  )
  .map((entry) => entry.pid);

const listenerPid = await platform.net.listenerPid(Number(port));
const pid = chromePids.find((candidate) => candidate === listenerPid);
if (!pid) {
  process.stderr.write("The local automation endpoint does not belong to the dedicated Chrome profile.\n");
  process.exit(1);
}

try {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const version = await response.json();
  if (typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error("Missing Chrome debugger URL");
  }
} catch (error) {
  process.stderr.write(`The dedicated Chrome automation endpoint is unavailable: ${error.message}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ verified: true, pid, port: Number(port), profileDir })}\n`);
