#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSessionLaunchPipeline } from "../src/core/session-orchestrator.mjs";
import {
  getMeetingProvider,
  normalizeMeeting,
} from "../src/providers/provider-registry.mjs";
import { getPlatformAdapter } from "../src/platform/platform-registry.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = getPlatformAdapter();
const readsUrlFromStdin = process.argv[2] === "--url-stdin";
if (!readsUrlFromStdin && !process.argv[2]) {
  process.stderr.write("Usage: node scripts/session-launch.mjs MEETING_URL | --url-stdin\n");
  process.exit(2);
}

const meetingUrl = readsUrlFromStdin ? readFileSync(0, "utf8").trim() : process.argv[2];
let meeting;
let provider;
try {
  meeting = normalizeMeeting(meetingUrl);
  provider = getMeetingProvider(meeting.providerId);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

function run(command, args = [], { input = null, acceptedExitCodes = [0] } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = platform.process.spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: [input === null ? "inherit" : "pipe", "inherit", "inherit"],
    });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (acceptedExitCodes.includes(code)) {
        resolvePromise({ exitCode: code });
        return;
      }
      const error = new Error(`Session operation stopped (${code ?? signal})`);
      error.exitCode = Number.isInteger(code) ? code : 1;
      rejectPromise(error);
    });
    if (input !== null) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

const cdp = `http://127.0.0.1:${process.env.MEETING_COPILOT_CDP_PORT || "9223"}`;
const cli = (name, args = [], options = {}) => run(
  process.execPath,
  [resolve(repoRoot, `src/cli/${name}.mjs`), ...args],
  options,
);
const operations = {
  installControlUi: () => cli("install-control-ui", ["--quiet"]),
  configureAudio: () => cli("configure-audio"),
  startVoice: () => cli("open-chatgpt-live", ["--restart-profile"]),
  prepareParticipant: async () => {
    const preparation = await cli(
      "open-gpt-participant",
      ["--url-stdin", "--join"],
      { input: `${meeting.url}\n`, acceptedExitCodes: [0, 16] },
    );
    return {
      manualActionRequired: preparation.exitCode === 16,
    };
  },
  setPostJoinMicrophone: (state) => run(process.execPath, [
    resolve(repoRoot, "scripts/set-participant-mic.mjs"),
    "--provider", provider.id,
    "--cdp", cdp,
    "--assume-before", "muted",
    "--wait", "60",
    "--state", state,
  ]),
  closeParticipantBrowser: async () => {
    process.stderr.write("[INFO] Closing the dedicated browser after launch failure.\n");
    await cli("close-dedicated-chrome");
  },
  restoreAudio: async () => {
    process.stderr.write("[INFO] Finishing Meetron audio cleanup after launch failure.\n");
    await cli("restore-audio");
  },
};

try {
  const result = await runSessionLaunchPipeline({ provider, operations });
  if (result.manualActionRequired) {
    process.stdout.write(`\n${result.providerLabel} needs a manual check. The dedicated Chrome window will remain open.\n`);
    process.stdout.write("Complete the indicated check and join from that window; post-join microphone automation was skipped.\n");
    process.exitCode = 16;
  } else {
    process.stdout.write(`\nChatGPT Voice is active and the Meetron participant has started ${result.providerLabel}.\n`);
    if (result.postJoinMicrophone === "unmuted") {
      process.stdout.write("The meeting microphone is unmuted; Project instructions control when ChatGPT speaks.\n");
    } else {
      process.stdout.write("Meetron audio routing is enabled and the meeting microphone remains muted for safety.\n");
    }
  }
} catch (error) {
  process.exitCode = error.exitCode || 1;
}
