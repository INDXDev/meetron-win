#!/usr/bin/env node

import { resolve } from "node:path";
import { cliError, repoRoot, runMain, runVisible } from "./cli-utils.mjs";

const usage = `Usage: node src/cli/install-audio-deps.mjs [options]

Builds Meetron's Core Audio helper and installs its two virtual audio devices.

Options:
  --dry-run       Show what would be installed.
  --restart-audio Restart Core Audio after installation (development only).
  --yes           Accepted for compatibility.
`;

runMain(async () => {
  let dryRun = false;
  let restartAudio = false;
  for (const argument of process.argv.slice(2)) {
    if (["-h", "--help"].includes(argument)) { process.stdout.write(usage); return; }
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--restart-audio") restartAudio = true;
    else if (!["--yes", "--accept-blackhole-license"].includes(argument)) throw cliError(`Unknown argument: ${argument}\n${usage}`);
  }
  if (process.platform !== "darwin" && process.env.MEETRON_PLATFORM !== "darwin") throw cliError("Error: this installer supports macOS only.", 1);
  const installer = resolve(repoRoot, "native/audio-driver/install-driver.sh");
  if (dryRun) {
    await runVisible(installer, ["--dry-run"]);
    process.stdout.write("[DRY RUN] build the native Core Audio control helper\n");
    return;
  }
  await runVisible(process.execPath, [resolve(repoRoot, "src/cli/build-audio-control.mjs")]);
  await runVisible(installer, restartAudio ? ["--restart-audio"] : []);
  process.stdout.write("\nNext: log out or restart macOS, then run the check-env CLI.\n");
});
