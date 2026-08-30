#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { getAudioStatus } from "../../scripts/audio-backend.mjs";
import {
  cliError,
  platform,
  platformPaths,
  repoRoot,
  run,
  runMain,
  runVisible,
  spawnNode,
  versionAtLeast,
  waitForChild,
} from "./cli-utils.mjs";
import { findChrome } from "./chrome-session.mjs";

const usage = `Usage: node src/cli/setup-meetron.mjs [--check-only]

Prepares Meetron's JavaScript dependencies and Chrome Native Messaging Host,
then checks the selected audio backend and required applications.
`;

async function installedPackageVersion(receiptId) {
  try {
    const { stdout } = await run("pkgutil", ["--pkg-info", receiptId]);
    return stdout.match(/^version:\s*(.+)$/m)?.[1].trim() || "";
  } catch {
    return "";
  }
}

function packageCandidates(version) {
  if (process.env.MEETRON_SETUP_PKG_PATH) return [process.env.MEETRON_SETUP_PKG_PATH];
  const roots = [
    repoRoot,
    resolve(repoRoot, "installer"),
    resolve(repoRoot, "../installer"),
    resolve(repoRoot, "dist/release"),
    resolve(repoRoot, "dist"),
    resolve(process.env.HOME || homedir(), "Downloads"),
    resolve(process.env.HOME || homedir(), "Desktop"),
  ];
  const exact = roots.map((root) => resolve(root, `MeetronAudio-${version}.pkg`));
  const fallback = roots.flatMap((root) => {
    try {
      return readdirSync(root).filter((name) => /^MeetronAudio-.*\.pkg$/.test(name)).map((name) => resolve(root, name));
    } catch { return []; }
  });
  return [...exact, ...fallback];
}

async function verifyPackage(packagePath) {
  const { stdout, stderr } = await run("pkgutil", ["--check-signature", packagePath]);
  const signature = `${stdout}${stderr}`;
  if (!signature.includes("Developer ID Installer: Yuki Inaba (SHDVCBHNJW)")) {
    throw new Error("The PKG developer identity is not Yuki Inaba; it was not opened.");
  }
  if (!signature.includes("Notarization: trusted by the Apple notary service")) {
    throw new Error("The PKG is not trusted by the Apple notary service; it was not opened.");
  }
  await run("spctl", ["--assess", "--type", "install", packagePath]);
  const checksumPath = `${packagePath}.sha256`;
  if (existsSync(checksumPath)) {
    const expected = readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];
    const actual = createHash("sha256").update(readFileSync(packagePath)).digest("hex");
    if (actual !== expected) throw new Error("The PKG SHA-256 checksum does not match.");
    process.stdout.write("[OK] PKG signature, notarization, and checksum were verified.\n");
  } else {
    process.stdout.write("[OK] PKG signature and notarization were verified.\n");
  }
}

runMain(async () => {
  let checkOnly = false;
  for (const argument of process.argv.slice(2)) {
    if (["-h", "--help"].includes(argument)) { process.stdout.write(usage); return; }
    if (argument === "--check-only") checkOnly = true;
    else throw cliError(`Unknown option: ${argument}\n${usage}`);
  }
  process.stdout.write("Meetron setup\n=============\n");
  if (!["darwin", "win32"].includes(platform.id)) throw cliError("[ERROR] Meetron supports macOS and Windows 11 only.", 1);
  if (platform.id === "darwin") {
    const macosVersion = await run("sw_vers", ["-productVersion"]).then(
      ({ stdout }) => stdout.trim(),
      () => "unknown",
    );
    if (!(Number(macosVersion.split(".")[0]) >= 13)) {
      throw cliError(`[ERROR] macOS 13 or later is required (found ${macosVersion}).`, 1);
    }
    const requiredVersion = process.env.MEETRON_SETUP_AUDIO_VERSION || "0.1.2";
    const receiptId = process.env.MEETRON_SETUP_RECEIPT_ID || "io.github.bb8ad8.meetron.audio.pkg";
    const installed = await installedPackageVersion(receiptId);
    if (!installed || !versionAtLeast(installed, requiredVersion)) {
      if (installed) process.stdout.write(`[UPDATE] Meetron Audio ${requiredVersion} is required (installed: ${installed}).\n`);
      const packagePath = packageCandidates(requiredVersion).find(existsSync);
      if (packagePath) {
        await verifyPackage(packagePath);
        process.stdout.write(`[NEXT] Install Meetron Audio and restart the Mac:\n       ${packagePath}\n`);
        if (!checkOnly && process.env.MEETRON_SETUP_NO_OPEN !== "1") {
          await run("open", ["-R", packagePath]);
          await run("open", [packagePath]);
        }
      } else {
        process.stdout.write(`[NEXT] Download Meetron Audio from GitHub Releases:\n       ${process.env.MEETRON_SETUP_RELEASE_URL || "https://github.com/bb8ad8/meetron/releases/latest"}\n`);
      }
      return 20;
    }
    process.stdout.write(`[OK] Meetron Audio PKG is installed (${installed}).\n`);
  } else {
    const powershell = resolve(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const build = await run(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Environment]::OSVersion.Version.Build",
    ]).then(({ stdout }) => Number(stdout.trim()), () => 0);
    if (build < 22_000) throw cliError(`[ERROR] Windows 11 is required (found OS build ${build || "unknown"}).`, 1);
    const audio = await getAudioStatus().catch(() => ({ backend: "", ready: false }));
    if (!audio.ready) {
      process.stdout.write("[NEXT] Select the experimental webrtc-loopback backend or install/configure VB-CABLE A+B before starting a meeting.\n");
    } else process.stdout.write(`[OK] Windows audio backend is ready (${audio.backend}).\n`);
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (![22, 24].includes(nodeMajor)) throw cliError(`[ERROR] Node.js 22 or 24 LTS is required (found ${process.version}).`, 1);
  const chrome = findChrome({ home: process.env.HOME || homedir(), env: process.env, candidates: platformPaths.chromeApplications });
  if (!chrome) throw cliError("[ERROR] Google Chrome was not found. Install the official Google Chrome build first.", 1);
  if (!checkOnly) {
    if (process.env.MEETRON_PACKAGED === "1") {
      process.stdout.write("\n[OK] Using the Node.js runtime and dependencies bundled in the MSIX.\n");
    } else {
      process.stdout.write("\nInstalling local dependencies...\n");
      await runVisible("npm", ["ci"]);
    }
    await waitForChild(spawnNode(resolve(repoRoot, "src/cli/install-control-ui.mjs")));
  }
  process.stdout.write("\nChecking the completed setup...\n");
  try {
    await waitForChild(spawnNode(resolve(repoRoot, "src/cli/check-env.mjs")));
  } catch {
    process.stderr.write("\nMeetron Audio may still be waiting for a macOS restart. Restart the Mac, then run setup again.\n");
    return 21;
  }
  const extensionPath = platform.id === "win32" && process.env.MEETRON_PACKAGED === "1"
    ? resolve(platformPaths.runtimeDir, "../Extension")
    : resolve(repoRoot, "extension");
  process.stdout.write(`\nNext manual steps\n-----------------\n1. Load unpacked in regular Chrome from:\n   ${extensionPath}\n2. Run the dedicated Chrome setup and load the same extension there.\n3. Sign in to Google and ChatGPT in the dedicated Chrome window.\n`);
  if (!checkOnly) {
    platform.chrome.launch(chrome, ["--new-window", "chrome://extensions/"], { detached: true, stdio: "ignore" }).unref();
    await waitForChild(spawnNode(resolve(repoRoot, "src/cli/open-control-ui-setup.mjs")));
  }
  process.stdout.write(`\nMeetron ${platform.id === "win32" ? "Windows" : "local"} setup completed. Chrome sign-in and extension loading remain manual.\n`);
});
