#!/usr/bin/env node

import { existsSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { restoreAudio } from "../../scripts/audio-backend.mjs";
import { getCredentialStore } from "../platform/credential-store-registry.mjs";
import { PROJECT_URL_CREDENTIAL } from "../platform/project-settings.mjs";
import {
  cliError,
  configurationPath,
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
  if (removeAudioDriver && platform.id === "win32") {
    throw cliError(
      "Meetron does not own the third-party VB-CABLE driver. Remove it only with VB-Audio's own uninstaller.",
      1,
    );
  }
  const home = process.env.HOME || homedir();
  const paths = platform.paths.resolve({ repoRoot, home, env: process.env });
  const runtimeDir = process.env.MEETING_COPILOT_RUNTIME_DIR || paths.runtimeDir;
  const profileRoot = resolve(home, "Library/Application Support/MeetingCopilot");
  if (removeData) {
    const defaultPaths = platform.paths.resolve({
      repoRoot,
      home,
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        !["MEETING_COPILOT_RUNTIME_DIR", "MEETING_COPILOT_PROFILE_DIR"].includes(name))),
    });
    const expectedRuntime = platform.id === "win32"
      ? defaultPaths.runtimeDir
      : resolve(repoRoot, ".meeting-copilot-runtime");
    if (canonical(runtimeDir) !== canonical(expectedRuntime)) {
      throw cliError(`Refusing to remove unexpected runtime path: ${runtimeDir}`, 1);
    }
    const dedicatedProfileIsSafe = platform.id === "win32"
      ? canonical(paths.dedicatedProfileDir) === canonical(defaultPaths.dedicatedProfileDir)
      : isChild(profileRoot, paths.dedicatedProfileDir);
    if (!dedicatedProfileIsSafe) {
      throw cliError(`Refusing to remove a Chrome profile outside Meetron data: ${paths.dedicatedProfileDir}`, 1);
    }
    const expectedLegacyProfile = platform.id === "win32"
      ? defaultPaths.legacyProfileDir
      : resolve(profileRoot, "ChatGPTVoiceChrome");
    if (canonical(paths.legacyProfileDir) !== canonical(expectedLegacyProfile)) {
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
    if (platform.id === "win32") {
      try {
        await getCredentialStore(platform.id, { repoRoot }).delete(PROJECT_URL_CREDENTIAL);
      } catch (error) {
        process.stderr.write(`Could not remove the Windows Credential Manager entry: ${error.message}\n`);
      }
      rmSync(resolve(dirname(runtimeDir), "shell-settings.json"), { force: true });
      rmSync(resolve(dirname(runtimeDir), "Extension"), { recursive: true, force: true });
    }
    for (const target of [runtimeDir, paths.dedicatedProfileDir, paths.legacyProfileDir]) {
      rmSync(target, { recursive: true, force: true });
    }
    rmSync(configurationPath, { force: true });
    process.stdout.write("Removed Meetron local data and dedicated Chrome profiles.\n");
  }
  process.stdout.write("Remove Meetron Controls from Chrome in chrome://extensions.\n");
});
