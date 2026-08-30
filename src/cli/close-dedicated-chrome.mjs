#!/usr/bin/env node

import { cliError, loadEnvironment, platformPaths, quoteCommand, runMain } from "./cli-utils.mjs";
import { stopProfileGracefully } from "./chrome-session.mjs";

const usage = `Usage: node src/cli/close-dedicated-chrome.mjs [--dry-run]

Closes the shared Meetron Chrome profile. This also ends ChatGPT Voice
and disconnects its dedicated meeting participant.
`;

runMain(async () => {
  const args = process.argv.slice(2);
  if (args.some((value) => ["-h", "--help"].includes(value))) {
    process.stdout.write(usage);
    return;
  }
  if (args.length > 1 || (args.length && args[0] !== "--dry-run")) throw cliError(`Unknown option: ${args[0]}`);
  const env = loadEnvironment();
  const profileDir = env.MEETING_COPILOT_PROFILE_DIR || platformPaths.dedicatedProfileDir;
  if (args[0] === "--dry-run") {
    process.stdout.write(`[DRY RUN] close Meetron Chrome profile: ${quoteCommand([profileDir])}\n`);
    return;
  }
  const count = await stopProfileGracefully(profileDir);
  process.stdout.write(count ? "Meetron Chrome closed.\n" : "Meetron Chrome is not running.\n");
});
