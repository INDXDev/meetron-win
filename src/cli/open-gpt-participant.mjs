#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getAudioStatus } from "../../scripts/audio-backend.mjs";
import { createProviderPreparationPlan } from "../providers/provider-automation.mjs";
import { getMeetingProvider, normalizeMeeting } from "../providers/provider-registry.mjs";
import {
  cliError,
  loadEnvironment,
  parseInteger,
  platform,
  platformPaths,
  quoteCommand,
  repoRoot,
  spawnNode,
  waitForChild,
  runMain,
} from "./cli-utils.mjs";
import { chromeLaunchArguments, ensureChrome, findChrome } from "./chrome-session.mjs";

const usage = `Usage: node src/cli/open-gpt-participant.mjs [options] MEETING_URL

Opens a Google Meet or Zoom tab in the shared Meetron Chrome profile.

Options:
  --auto-prepare       Configure the selected provider without joining.
  --join               Prepare and request admission automatically.
  --join-delay SEC     Override the delay before requesting admission.
  --restart-profile    Restart the shared profile; this also closes ChatGPT.
  --url-stdin          Read the meeting invitation URL from standard input.
  --dry-run            Print the launch command without opening Chrome.
`;

runMain(async () => {
  const env = loadEnvironment();
  let dryRun = false;
  let autoPrepare = false;
  let join = false;
  let restart = false;
  let urlStdin = false;
  let meetingUrl = "";
  let joinDelay = env.MEETING_COPILOT_JOIN_DELAY || "2";
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["-h", "--help"].includes(argument)) {
      process.stdout.write(usage);
      return;
    }
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--auto-prepare") autoPrepare = true;
    else if (argument === "--join") { autoPrepare = true; join = true; }
    else if (argument === "--join-delay") joinDelay = args[++index] ?? "";
    else if (argument === "--restart-profile") restart = true;
    else if (argument === "--url-stdin") urlStdin = true;
    else if (argument.startsWith("--")) throw cliError(`Unknown option: ${argument}\n${usage}`);
    else if (meetingUrl) throw cliError(`Only one meeting URL may be supplied.\n${usage}`);
    else meetingUrl = argument;
  }
  const delaySeconds = parseInteger(joinDelay, "--join-delay");
  if (urlStdin) {
    if (meetingUrl) throw cliError("Do not combine --url-stdin with a positional meeting URL.");
    meetingUrl = readFileSync(0, "utf8").trim();
  }
  if (!meetingUrl) throw cliError(`A meeting URL is required.\n${usage}`);
  const meeting = normalizeMeeting(meetingUrl);
  const provider = getMeetingProvider(meeting.providerId);
  const profileDir = env.MEETING_COPILOT_PROFILE_DIR || platformPaths.dedicatedProfileDir;
  const participantName = env.MEETING_COPILOT_NAME || "GPT-Live";
  const port = env.MEETING_COPILOT_CDP_PORT || "9223";
  const plan = createProviderPreparationPlan(provider, meeting, {
    cdp: `http://127.0.0.1:${port}`,
    participantName,
    requestJoin: join,
    joinDelay: delaySeconds,
  });
  const chromePath = findChrome({ home: process.env.HOME || homedir(), env, candidates: platformPaths.chromeApplications });
  if (!chromePath) throw cliError("Google Chrome was not found.\nSet MEETING_COPILOT_CHROME_PATH to the browser .app path.", 1);
  process.stdout.write(`Provider:     ${provider.label}\n`);
  process.stdout.write(`Browser:      ${chromePath}\n`);
  process.stdout.write(`Profile data: ${profileDir}\n`);
  process.stdout.write(`Display name: ${participantName} (set or verify in the meeting UI)\n`);
  // The shared profile is always started with its automation endpoint, because
  // even the non-preparing path drives the new tab over CDP. Print exactly the
  // arguments ensureChrome() will use.
  const launchArgs = chromeLaunchArguments({ profileDir, port, url: plan.initialUrl });
  if (dryRun) {
    process.stdout.write(`[DRY RUN] open -na ${quoteCommand([chromePath])} --args ${quoteCommand(launchArgs)}\n`);
    if (join) {
      process.stdout.write(provider.automation.supportsJoinDelay
        ? `[DRY RUN] prepare Meet, wait ${delaySeconds} seconds, and request admission\n`
        : `[DRY RUN] prepare ${provider.label} and request admission\n`);
    }
    return;
  }
  const executable = platform.chrome.executable(chromePath);
  if (!existsSync(executable)) throw cliError(`Chrome executable was not found at ${executable}.`, 1);
  if (!existsSync(resolve(repoRoot, "node_modules/playwright-core"))) throw cliError("playwright-core is required. Run: npm ci", 1);
  await ensureChrome({ chromePath, profileDir, port, url: plan.initialUrl, restart });
  let manualJoinRequired = false;
  if (autoPrepare) {
    const child = spawnNode(resolve(repoRoot, "scripts", plan.preparationScript), plan.args, {
      stdio: [plan.stdin ? "pipe" : "inherit", "inherit", "inherit"],
    });
    const result = await waitForChild(child, {
      acceptedExitCodes: [0, 13, 14, 15, 16],
      input: plan.stdin || null,
    });
    if (result.exitCode === 13) throw cliError("Automatic admission requires signing in to Google in this dedicated browser.", 13);
    if (result.exitCode === 14) throw cliError("Google Meet rejected the admission request.", 14);
    if (result.exitCode === 15) throw cliError("Meet accepted the click, but its resulting state could not be determined.", 15);
    manualJoinRequired = result.exitCode === 16;
  } else {
    const child = spawnNode(resolve(repoRoot, "scripts/open-chrome-page.mjs"), [
      "--cdp", `http://127.0.0.1:${port}`, "--url-stdin",
    ], { stdio: ["pipe", "ignore", "inherit"] });
    await waitForChild(child, { input: meeting.url });
  }
  if (!autoPrepare) {
    const audio = await getAudioStatus();
    process.stdout.write(`\nBrowser opened. Before joining:\n  1. Set the participant name to ${participantName}.\n  2. Set microphone/input to ${audio.routing.meetingMicrophone.name}.\n  3. Set speaker/output to ${audio.routing.meetingSpeaker.name}.\n  4. Keep the meeting microphone muted until the routing test is ready.\n`);
  } else if (manualJoinRequired) {
    process.stdout.write(`\n${provider.label} needs one manual confirmation; the dedicated Chrome window remains open.\n`);
    return 16;
  } else {
    process.stdout.write(`\n${provider.label} is prepared with Meetron audio routing.\n`);
  }
});
