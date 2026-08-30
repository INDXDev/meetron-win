#!/usr/bin/env node

import { resolve } from "node:path";
import {
  cliError,
  loadEnvironment,
  parseInteger,
  platformPaths,
  repoRoot,
  spawnNode,
  waitForChild,
  runMain,
} from "./cli-utils.mjs";

const usage = `Usage: node src/cli/set-meet-mic.mjs [--wait SEC] [--assume-before STATE] STATE

Controls the microphone of the dedicated Google Meet participant.
STATE is one of: unmute, mute, toggle.
`;

runMain(async () => {
  const env = loadEnvironment();
  let wait = env.MEETING_COPILOT_MIC_WAIT || "0";
  let assumeBefore = env.MEETING_COPILOT_MIC_ASSUME_BEFORE || "";
  let state = "";
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["-h", "--help"].includes(argument)) {
      process.stdout.write(usage);
      return;
    }
    if (argument === "--wait") wait = args[++index] ?? "";
    else if (argument === "--assume-before") assumeBefore = args[++index] ?? "";
    else if ({ unmute: 1, mute: 1, toggle: 1 }[argument]) state = { unmute: "unmuted", mute: "muted", toggle: "toggle" }[argument];
    else throw cliError(`Unknown option or state: ${argument}\n${usage}`);
  }
  parseInteger(wait, "--wait");
  if (!state) throw cliError(`A microphone state is required.\n${usage}`);
  if (assumeBefore && !["muted", "unmuted"].includes(assumeBefore)) {
    throw cliError("--assume-before must be muted or unmuted.");
  }
  const port = env.MEETING_COPILOT_CDP_PORT || "9223";
  const profileDir = env.MEETING_COPILOT_PROFILE_DIR || platformPaths.dedicatedProfileDir;
  const verify = spawnNode(resolve(repoRoot, "scripts/verify-dedicated-chrome.mjs"), [
    "--profile-dir", profileDir, "--port", port,
  ]);
  await waitForChild(verify);
  const controlArgs = [
    "--provider", "google-meet",
    "--cdp", `http://127.0.0.1:${port}`,
    "--state", state,
    "--wait", wait,
    ...(assumeBefore ? ["--assume-before", assumeBefore] : []),
  ];
  return (await waitForChild(spawnNode(resolve(repoRoot, "scripts/set-participant-mic.mjs"), controlArgs))).exitCode;
});
