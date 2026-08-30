#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cliError, loadEnvironment, repoRoot, spawnNode, waitForChild, runMain } from "./cli-utils.mjs";

const usage = "Usage: node src/cli/start-meetron.mjs MEETING_URL | --url-stdin\n";

runMain(async () => {
  if (process.argv.slice(2).some((value) => ["-h", "--help"].includes(value))) {
    process.stdout.write(usage);
    return;
  }
  if (process.argv.length !== 3) throw cliError(usage.trim());
  const argument = process.argv[2];
  const meetingUrl = argument === "--url-stdin" ? readFileSync(0, "utf8").trim() : argument;
  if (!meetingUrl) throw cliError("A meeting URL is required.");
  const originalPort = process.env.MEETING_COPILOT_CDP_PORT;
  Object.assign(process.env, loadEnvironment());
  if (originalPort) process.env.MEETING_COPILOT_CDP_PORT = originalPort;
  const child = spawnNode(resolve(repoRoot, "scripts/session-launch.mjs"), ["--url-stdin"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  const result = await waitForChild(child, { acceptedExitCodes: [0, 16], input: `${meetingUrl}\n` });
  return result.exitCode;
});
