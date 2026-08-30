#!/usr/bin/env node

import { existsSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { restoreAudio } from "../../scripts/audio-backend.mjs";
import {
  cliError,
  platform,
  repoRoot,
  run,
  runMain,
  spawnNode,
  waitForChild,
} from "./cli-utils.mjs";

const usage = `Usage: node src/cli/uninstall.mjs [--remove-data] [--remove-audio-driver] [--yes]

Removes Native Messaging Host registration. --remove-data also removes local
settings, runtime files, and dedicated Chrome profiles.
`;

function canonical(path) {
  let current = resolve(path);
  const missing = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(existsSync(current) ? realpathSync.native(current) : current, ...missing);
}

function isChild(root, candidate) {
  const child = relative(canonical(root), canonical(candidate));
  return child && !child.startsWith("..") && !isAbsolute(child);
}

runMain(async () => {
  let removeData = false;
  let removeAudioDriver = false;
  let confirmed = false;
  for (const argument of process.argv.slice(2)) {
    if (["-h", "--help"].includes(argument)) { process.stdout.write(usage); return; }
    if (argument === "--remove-data") removeData = true;
    else if (argument === "--remove-audio-driver") removeAudioDriver = true;
    else if (argument === "--yes") confirmed = true;
    else throw cliError(`Unknown option: ${argument}\n${usage}`);
  }
  if ((removeData || removeAudioDriver) && !confirmed) {
    throw cliError("--remove-data and --remove-audio-driver require --yes.");
  }
  const home = process.env.HOME || homedir();
  const paths = platform.paths.resolve({ repoRoot, home, env: process.env });
  const runtimeDir = process.env.MEETING_COPILOT_RUNTIME_DIR || paths.runtimeDir;
  const profileRoot = resolve(home, "Library/Application Support/MeetingCopilot");
  if (removeData) {
    if (canonical(runtimeDir) !== canonical(resolve(repoRoot, ".meeting-copilot-runtime"))) {
      throw cliError(`Refusing to remove unexpected runtime path: ${runtimeDir}`, 1);
    }
    if (!isChild(profileRoot, paths.dedicatedProfileDir)) {
      throw cliError(`Refusing to remove a Chrome profile outside Meetron data: ${paths.dedicatedProfileDir}`, 1);
    }
    if (canonical(paths.legacyProfileDir) !== canonical(resolve(profileRoot, "ChatGPTVoiceChrome"))) {
      throw cliError(`Refusing to remove unexpected legacy profile path: ${paths.legacyProfileDir}`, 1);
    }
  }
  if (existsSync(resolve(runtimeDir, "audio-original.json"))) {
    try { await restoreAudio(); }
    catch (error) {
      throw cliError(`Audio restoration failed. Uninstall was stopped and recovery data was preserved.\n${error.message}`, 1);
    }
  }
  await waitForChild(spawnNode(resolve(repoRoot, "src/cli/install-control-ui.mjs"), ["--uninstall", "--quiet"]));
  if (removeAudioDriver) await run(resolve(repoRoot, "native/audio-driver/uninstall-driver.sh"));
  if (removeData) {
    for (const target of [runtimeDir, paths.dedicatedProfileDir, paths.legacyProfileDir]) {
      rmSync(target, { recursive: true, force: true });
    }
    rmSync(resolve(repoRoot, ".meeting-copilot.env"), { force: true });
    process.stdout.write("Removed Meetron local data and dedicated Chrome profiles.\n");
  }
  process.stdout.write("Remove Meetron Controls from Chrome in chrome://extensions.\n");
});
