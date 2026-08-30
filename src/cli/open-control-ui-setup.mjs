#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  loadEnvironment,
  platformPaths,
  repoRoot,
  spawnNode,
  waitForChild,
  runMain,
} from "./cli-utils.mjs";
import { endpointOwner, ensureChrome, findChrome } from "./chrome-session.mjs";

runMain(async () => {
  await waitForChild(spawnNode(resolve(repoRoot, "src/cli/install-control-ui.mjs"), ["--quiet"]));
  const env = loadEnvironment();
  const profileDir = env.MEETING_COPILOT_PROFILE_DIR || platformPaths.dedicatedProfileDir;
  const port = env.MEETING_COPILOT_CDP_PORT || "9223";
  const chromePath = findChrome({ home: process.env.HOME || homedir(), env, candidates: platformPaths.chromeApplications });
  if (!chromePath) throw new Error("Google Chrome was not found.");
  if (await endpointOwner({ profileDir, port })) {
    await waitForChild(spawnNode(resolve(repoRoot, "scripts/open-chrome-page.mjs"), [
      "--cdp", `http://127.0.0.1:${port}`, "--url", "chrome://extensions/",
    ]));
  } else {
    await ensureChrome({ chromePath, profileDir, port, url: "chrome://extensions/" });
  }
  process.stdout.write(`\nIn the shared Meetron Chrome window:\n  1. Enable Developer mode.\n  2. Click Load unpacked.\n  3. Select: ${resolve(repoRoot, "extension")}\n  4. Confirm the extension ID is: jlikakgdldiihhflkobhnpfegjlcakdd\n`);
});
