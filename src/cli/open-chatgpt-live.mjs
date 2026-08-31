#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  cliError,
  configurationPath,
  loadEnvironment,
  platform,
  platformPaths,
  quoteCommand,
  repoRoot,
  spawnNode,
  waitForChild,
  runMain,
} from "./cli-utils.mjs";
import { ensureChrome, findChrome, stopProfileGracefully } from "./chrome-session.mjs";
import { loadProjectUrl } from "../platform/project-settings.mjs";

const usage = `Usage: node src/cli/open-chatgpt-live.mjs [options]

Opens a new voice chat in the shared Meetron Chrome profile.

Options:
  --project-url URL    Override the configured ChatGPT Project URL.
  --restart-profile   Restart the whole shared profile before initial launch.
  --replace-tab       Replace only ChatGPT tabs and preserve an active meeting.
  --dry-run           Print the launch command without opening Chrome.
  -h, --help          Show this help.
`;

runMain(async () => {
  const environmentOverrides = { ...process.env };
  const env = loadEnvironment();
  Object.assign(env, environmentOverrides);
  let projectUrl = "";
  let restart = false;
  let replaceTab = false;
  let dryRun = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["-h", "--help"].includes(argument)) {
      process.stdout.write(usage);
      return;
    }
    if (argument === "--project-url") projectUrl = args[++index] ?? "";
    else if (argument === "--restart-profile") restart = true;
    else if (argument === "--replace-tab") replaceTab = true;
    else if (argument === "--dry-run") dryRun = true;
    else throw cliError(`Unknown option: ${argument}\n${usage}`);
  }
  projectUrl ||= await loadProjectUrl({
    platformId: platform.id,
    repoRoot,
    env,
    envPath: configurationPath,
  });
  if (!/^https:\/\/chatgpt\.com\/g\/g-p-[^/]+\/project/.test(projectUrl)) {
    throw cliError("Configure a ChatGPT Project landing URL before opening ChatGPT Live.");
  }
  const chromePath = findChrome({ home: process.env.HOME || homedir(), env, candidates: platformPaths.chromeApplications });
  if (!chromePath) throw cliError("Google Chrome was not found.", 1);
  const executable = platform.chrome.executable(chromePath);
  if (!dryRun && !existsSync(executable)) throw cliError(`Chrome executable was not found at ${executable}.`, 1);
  const profileDir = env.MEETING_COPILOT_PROFILE_DIR || platformPaths.dedicatedProfileDir;
  const port = env.MEETING_COPILOT_CDP_PORT || "9223";
  const launchArgs = [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    "--use-fake-ui-for-media-stream",
    `--user-data-dir=${profileDir}`,
    "--no-first-run", "--new-window", projectUrl,
  ];
  if (dryRun) {
    process.stdout.write(`[DRY RUN] open -na ${quoteCommand([chromePath])} --args ${quoteCommand(launchArgs)}\n`);
    return;
  }
  if (!existsSync(resolve(repoRoot, "node_modules/playwright-core"))) {
    throw cliError("playwright-core is required. Run: npm ci", 1);
  }
  if (platformPaths.legacyProfileDir !== profileDir) {
    const legacy = await platform.chrome.profileProcesses(platformPaths.legacyProfileDir);
    if (legacy.length) {
      process.stdout.write("[INFO] Closing the retired pre-0.6 ChatGPT Chrome profile.\n");
      await stopProfileGracefully(platformPaths.legacyProfileDir);
    }
  }
  await ensureChrome({ chromePath, profileDir, port, url: projectUrl, restart });
  const prepareArgs = ["--cdp", `http://127.0.0.1:${port}`, "--project-url", projectUrl];
  if (replaceTab) prepareArgs.push("--replace-tab");
  const result = await waitForChild(
    spawnNode(resolve(repoRoot, "scripts/prepare-chatgpt-live.mjs"), prepareArgs),
    { acceptedExitCodes: [0, 10] },
  );
  if (result.exitCode === 10) {
    process.stdout.write("\nSign in to ChatGPT in the dedicated browser, then rerun this command.\n");
    return 10;
  }
  process.stdout.write("\nChatGPT Voice is active in a new Meetron chat.\n");
});
