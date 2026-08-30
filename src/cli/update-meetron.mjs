#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getAudioStatus } from "../../scripts/audio-backend.mjs";
import {
  cliError,
  delay,
  platform,
  repoRoot,
  run,
  runMain,
  runVisible,
  spawnNode,
  versionAtLeast,
  waitForChild,
} from "./cli-utils.mjs";

const usage = `Usage: node src/cli/update-meetron.mjs [--dry-run] [--target DIRECTORY]

Updates an existing Meetron source installation in place so Chrome keeps the
same unpacked-extension path. Local configuration and runtime state are preserved.
`;
const excludedTopLevel = new Set([
  ".git", "node_modules", "docs", "dist", ".meeting-copilot.env", ".meeting-copilot-runtime",
]);
const obsoleteShellScripts = Object.freeze([
  "build-audio-control.sh", "check-env.sh", "close-dedicated-chrome.sh",
  "configure-audio.sh", "install-audio-deps.sh", "install-control-ui.sh",
  "native-host.sh", "open-chatgpt-live.sh", "open-control-ui-setup.sh",
  "open-gpt-participant.sh", "package-community-release.sh", "restore-audio.sh",
  "set-meet-mic.sh", "setup-meetron.sh", "start-meeting-copilot.sh",
  "start-meetron.sh", "uninstall.sh", "update-meetron.sh",
]);

function shouldExclude(name, topLevel) {
  return (topLevel && excludedTopLevel.has(name)) || name === ".build" || name === ".DS_Store" || /^MeetronAudio-.*\.pkg(?:\.sha256)?$/.test(name);
}

function copyTree(source, target, { topLevel = true } = {}) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (shouldExclude(entry.name, topLevel)) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to, { topLevel: false });
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function validTarget(candidate) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(candidate, "package.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(resolve(candidate, "extension/manifest.json"), "utf8"));
    return ["meetron", "meeting-copilot"].includes(pkg.name) &&
      manifest.name === "Meetron Controls" &&
      (existsSync(resolve(candidate, "scripts/native-host.mjs")) || existsSync(resolve(candidate, "scripts/native-host.sh")));
  } catch { return false; }
}

function targetFromManifest(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest.name !== "com.meeting_copilot.host" || typeof manifest.path !== "string") return "";
    const candidate = resolve(dirname(manifest.path), "..");
    return validTarget(candidate) ? candidate : "";
  } catch { return ""; }
}

function verifyUpdateManifest(target, manifestPath) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const [relativePath, expected] of Object.entries(manifest.files || {})) {
      const absolute = resolve(target, relativePath);
      const child = relative(resolve(target), absolute);
      if (!child || child.startsWith("..") || isAbsolute(child) || !statSync(absolute, { throwIfNoEntry: false })?.isFile()) return false;
      const actual = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      if (actual !== expected) return false;
    }
    return Boolean(manifest.files);
  } catch { return false; }
}

function sourceFiles(root, relativePath = "", output = {}) {
  for (const entry of readdirSync(resolve(root, relativePath), { withFileTypes: true })) {
    if (shouldExclude(entry.name, !relativePath)) continue;
    const childRelative = relativePath ? join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) sourceFiles(root, childRelative, output);
    else if (entry.isFile()) output[childRelative] = true;
  }
  return output;
}

function writeUpdateManifest(source, target, outputPath, version) {
  const files = {};
  for (const relativePath of Object.keys(sourceFiles(source)).sort()) {
    const installed = resolve(target, relativePath);
    if (!statSync(installed, { throwIfNoEntry: false })?.isFile()) throw new Error(`Updated file is missing: ${relativePath}`);
    files[relativePath] = createHash("sha256").update(readFileSync(installed)).digest("hex");
  }
  const temporary = `${outputPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version, files }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, outputPath);
  platform.fsSecurity.secureFile(outputPath);
}

async function installedPackageVersion(receiptId) {
  try {
    const { stdout } = await run("pkgutil", ["--pkg-info", receiptId]);
    return stdout.match(/^version:\s*(.+)$/m)?.[1].trim() || "";
  } catch {
    return "";
  }
}

runMain(async () => {
  let targetOverride = process.env.MEETRON_UPDATE_TARGET || "";
  let dryRun = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["-h", "--help"].includes(argument)) { process.stdout.write(usage); return; }
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--target") targetOverride = args[++index] || "";
    else throw cliError(`Unknown option: ${argument}\n${usage}`);
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (![22, 24].includes(nodeMajor)) throw cliError(`[ERROR] Node.js 22 or 24 LTS is required to update Meetron (found ${process.version}).`, 1);
  const sourceVersion = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).version;
  let targetRoot = "";
  if (targetOverride) {
    targetRoot = resolve(targetOverride);
    if (!validTarget(targetRoot)) throw cliError(`[ERROR] The selected directory is not a Meetron installation: ${targetOverride}`, 30);
  } else {
    const home = process.env.HOME || homedir();
    const paths = platform.paths.resolve({ repoRoot, home, env: process.env });
    for (const directory of paths.nativeMessagingManifestDirs) {
      targetRoot ||= targetFromManifest(resolve(directory, "com.meeting_copilot.host.json"));
    }
    if (!targetRoot) throw cliError("[ERROR] Existing Meetron installation was not found.\nRun Meetron Setup.command for a new installation instead.", 30);
  }
  const safeHome = resolve(process.env.HOME || homedir());
  if ([resolve("/"), safeHome].includes(targetRoot)) throw cliError(`[ERROR] Refusing to update an unsafe target path: ${targetRoot}`, 1);
  process.stdout.write(`Meetron updater\n===============\nCurrent installation: ${targetRoot}\nUpdate source:        ${repoRoot}\nTarget version:       ${sourceVersion}\n`);
  const updateManifestPath = resolve(targetRoot, ".meeting-copilot-runtime/update-manifest.json");
  if (repoRoot !== targetRoot && existsSync(resolve(targetRoot, ".git"))) {
    try { await run("git", ["-C", targetRoot, "diff", "--cached", "--quiet", "--ignore-submodules", "--"]); }
    catch { throw cliError("[ERROR] The existing Git checkout has staged changes.\nMeetron did not overwrite developer changes.", 31); }
    const tracked = (await run("git", ["-C", targetRoot, "status", "--porcelain", "--untracked-files=no"])).stdout.trim();
    if (tracked && !verifyUpdateManifest(targetRoot, updateManifestPath)) {
      throw cliError("[ERROR] The existing Git checkout has uncommitted tracked changes.\nMeetron did not overwrite developer changes.", 31);
    }
    if (tracked) process.stdout.write("[OK] Files written by the previous Meetron update were verified.\n");
  }
  if (dryRun) { process.stdout.write("[DRY RUN] Existing installation is safe to update in place.\n"); return; }
  if (repoRoot !== targetRoot) {
    const backupBase = resolve(process.env.MEETRON_UPDATE_BACKUP_DIR || resolve(safeHome, "Library/Application Support/Meetron/Backups"));
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "-").slice(0, 15);
    const backupRoot = resolve(backupBase, stamp);
    copyTree(targetRoot, backupRoot);
    copyTree(repoRoot, targetRoot);
    for (const name of obsoleteShellScripts) {
      rmSync(resolve(targetRoot, "scripts", name), { force: true });
    }
    process.stdout.write(`[OK] Previous source files were backed up to: ${backupRoot}\n`);
  }
  const installedVersion = JSON.parse(readFileSync(resolve(targetRoot, "package.json"), "utf8")).version;
  if (installedVersion !== sourceVersion) throw cliError("[ERROR] Updated source version could not be verified.", 1);
  process.stdout.write(`[OK] Meetron source updated to ${installedVersion}.\n`);
  platform.fsSecurity.secureDir(dirname(updateManifestPath));
  writeUpdateManifest(repoRoot, targetRoot, updateManifestPath, sourceVersion);
  if (process.env.MEETRON_UPDATE_SKIP_NPM !== "1") {
    await runVisible("npm", ["ci"], { cwd: targetRoot });
    await waitForChild(spawnNode(resolve(targetRoot, "src/cli/install-control-ui.mjs"), ["--quiet"], { cwd: targetRoot }));
    process.stdout.write("[OK] Dependencies and Native Messaging Host were updated.\n");
  } else process.stdout.write("[TEST] Dependency and Native Host installation skipped.\n");
  const requiredAudioVersion = process.env.MEETRON_UPDATE_AUDIO_VERSION || "0.1.2";
  const installedAudio = process.env.MEETRON_UPDATE_INSTALLED_AUDIO_VERSION === "none"
    ? ""
    : process.env.MEETRON_UPDATE_INSTALLED_AUDIO_VERSION ??
      await installedPackageVersion("io.github.bb8ad8.meetron.audio.pkg");
  let backend = process.env.MEETRON_UPDATE_AUDIO_BACKEND || "";
  let ready = process.env.MEETRON_UPDATE_AUDIO_READY === "true";
  if (!process.env.MEETRON_UPDATE_AUDIO_BACKEND || process.env.MEETRON_UPDATE_AUDIO_READY === undefined) {
    const status = await getAudioStatus();
    backend ||= status.backend || "";
    if (process.env.MEETRON_UPDATE_AUDIO_READY === undefined) ready = status.ready === true;
  }
  if (!installedAudio && !ready) {
    const configuredPreference = (() => {
      try {
        return readFileSync(resolve(targetRoot, ".meeting-copilot.env"), "utf8")
          .match(/^MEETING_COPILOT_AUDIO_BACKEND=['"]?([^'"\r\n]+)['"]?$/m)?.[1] || "";
      } catch { return ""; }
    })();
    if (["", "auto", "blackhole"].includes(configuredPreference)) {
      try {
        const inventory = (await run("system_profiler", ["SPAudioDataType"])).stdout;
        if (inventory.includes("BlackHole 2ch:") && inventory.includes("BlackHole 16ch:")) {
          backend = "blackhole";
          ready = true;
        }
      } catch {}
    }
  }
  let audioAction = "install";
  if (installedAudio && versionAtLeast(installedAudio, requiredAudioVersion)) {
    process.stdout.write(`[OK] Meetron Audio ${installedAudio} is already installed.\n`);
    audioAction = "current";
  } else if (!installedAudio && ready && ["blackhole", "legacy-custom"].includes(backend)) {
    process.stdout.write(`[OK] Keeping the compatible ${backend} audio backend. Meetron Audio PKG is not required.\n`);
    audioAction = "legacy";
  }
  if (process.env.MEETRON_UPDATE_SKIP_AUDIO_INSTALL === "1") {
    process.stdout.write(`[TEST] Audio package installation skipped (planned action: ${audioAction}).\n`);
    return;
  }
  if (audioAction !== "install") {
    process.stdout.write(`\nMeetron ${sourceVersion} was updated successfully.\nQuit and reopen Google Chrome to load extension version ${sourceVersion}.\n`);
    return;
  }
  const packagePath = [
    resolve(repoRoot, `MeetronAudio-${requiredAudioVersion}.pkg`),
    resolve(repoRoot, `dist/release/MeetronAudio-${requiredAudioVersion}.pkg`),
    resolve(targetRoot, `MeetronAudio-${requiredAudioVersion}.pkg`),
    resolve(safeHome, `Downloads/MeetronAudio-${requiredAudioVersion}.pkg`),
  ].find(existsSync);
  if (!packagePath) throw cliError(`[ERROR] MeetronAudio-${requiredAudioVersion}.pkg was not found next to the updater.`, 1);
  if (process.env.MEETRON_UPDATE_NO_OPEN === "1") {
    process.stdout.write(`[NEXT] Open and install: ${packagePath}\n`);
    return 20;
  }
  await run("open", ["-R", packagePath]);
  await run("open", [packagePath]);
  process.stdout.write(`[WAIT] Complete the macOS Installer. Meetron will detect version ${requiredAudioVersion} automatically.\n`);
  for (let attempt = 0; attempt < 450; attempt += 1) {
    const current = await installedPackageVersion("io.github.bb8ad8.meetron.audio.pkg");
    if (current && versionAtLeast(current, requiredAudioVersion)) {
      process.stdout.write(`[OK] Meetron Audio ${current} installation completed.\nRestart macOS to load the updated audio driver and Chrome extension.\n`);
      return 21;
    }
    await delay(2_000);
  }
  throw cliError("[ERROR] Meetron Audio installation was not completed within 15 minutes.", 1);
});
