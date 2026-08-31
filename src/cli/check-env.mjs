#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir, release } from "node:os";
import { getAudioStatus } from "../../scripts/audio-backend.mjs";
import { cliError, platform, platformPaths, repoRoot, run, runMain } from "./cli-utils.mjs";
import { findChrome } from "./chrome-session.mjs";

const usage = `Usage: node src/cli/check-env.mjs

Checks the operating system, Chrome, the native audio controller, and the
selected virtual audio backend.
`;

runMain(async () => {
  const args = process.argv.slice(2);
  if (args.some((value) => ["-h", "--help"].includes(value))) { process.stdout.write(usage); return; }
  if (args.length) throw cliError(`Unknown argument: ${args[0]}`);
  let missing = 0;
  let warnings = 0;
  const ok = (message) => process.stdout.write(`[OK]      ${message}\n`);
  const absent = (message) => { process.stdout.write(`[MISSING] ${message}\n`); missing += 1; };
  const info = (message) => process.stdout.write(`[INFO]    ${message}\n`);
  process.stdout.write("Meetron environment check\n=================================\n");
  if (platform.id === "darwin") {
    let version = "unknown";
    let architecture = process.arch;
    try { version = (await run("sw_vers", ["-productVersion"])).stdout.trim(); } catch {}
    try { architecture = (await run("uname", ["-m"])).stdout.trim(); } catch {}
    if (Number(version.split(".")[0]) >= 13) ok(`macOS ${version} (${architecture})`);
    else absent(`macOS 13 or later is required (found ${version}).`);
    if (architecture === "x86_64") info("Intel Mac support is best effort; the distributed audio package is Universal.");
  } else if (platform.id === "win32") {
    const version = release();
    const build = Number(version.split(".")[2]);
    if (Number.isInteger(build) && build >= 22_000) ok(`Windows 11 ${version} (${process.arch})`);
    else absent(`Windows 11 is required for the Windows beta (found ${version}).`);
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  let npmVersion = "not found";
  try { npmVersion = (await run("npm", ["--version"])).stdout.trim(); } catch {}
  if ([22, 24].includes(nodeMajor) && npmVersion !== "not found") ok(`Node.js: ${process.version}, npm: ${npmVersion}`);
  else absent(`Node.js 22 or 24 LTS and npm are required (found ${process.version}).`);
  const controller = platform.audioControl
    .executableCandidates({ repoRoot, env: process.env })
    .find((candidate) => candidate && existsSync(candidate));
  if (controller) ok(`Native audio controller: ${controller}`);
  else absent(`Native ${platform.label} audio controller has not been built.`);
  const chrome = findChrome({
    home: process.env.HOME || homedir(),
    env: process.env,
    candidates: platformPaths.chromeApplications,
  });
  if (chrome) ok(`Google Chrome: ${chrome}`);
  else absent("Google Chrome was not found.");
  process.stdout.write("\nAudio devices\n-------------\n");
  const audio = await getAudioStatus();
  for (const name of audio.devices || []) process.stdout.write(`  - ${name}\n`);
  if (audio.devicesReady) ok(`Audio backend: ${audio.backendLabel}`);
  else absent("The required Meetron virtual audio endpoints were not found.");
  if (audio.input) info(`Default input: ${audio.input}`);
  if (audio.output) info(`Default output: ${audio.output}`);
  process.stdout.write("\nSummary\n-------\n");
  if (!missing) {
    ok(`Required dependencies are present (${warnings} warning(s)).`);
    return;
  }
  process.stdout.write(`[MISSING] ${missing} required dependency check(s) failed.\n`);
  return 1;
});
