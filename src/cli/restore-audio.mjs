#!/usr/bin/env node

import { restoreAudio } from "../../scripts/audio-backend.mjs";
import { cliError, runMain } from "./cli-utils.mjs";

const usage = "Usage: node src/cli/restore-audio.mjs [--dry-run]\n";

runMain(async () => {
  const args = process.argv.slice(2);
  if (args.some((value) => ["-h", "--help"].includes(value))) {
    process.stdout.write(usage);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) throw cliError(usage.trim());
  process.stdout.write(`${JSON.stringify(await restoreAudio({ dryRun: args[0] === "--dry-run" }))}\n`);
});
