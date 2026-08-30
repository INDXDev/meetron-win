#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { cliError, platform, repoRoot, run, runMain } from "./cli-utils.mjs";

const usage = `Usage: node src/cli/install-windows-package.mjs --package PATH --publisher SUBJECT [--dry-run] [--allow-test-certificate]

Verifies the adjacent checksum, trusted timestamped Authenticode signature,
MSIX identity, and publisher before asking Windows to install or update Meetron.
`;

function snapshotProfile(path) {
  const localState = resolve(path, "Local State");
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) return { existed: false, localStateHash: "" };
  return {
    existed: true,
    localStateHash: statSync(localState, { throwIfNoEntry: false })?.isFile()
      ? createHash("sha256").update(readFileSync(localState)).digest("hex")
      : "",
  };
}

runMain(async () => {
  let packagePath = "";
  let publisher = "";
  let dryRun = false;
  let allowTestCertificate = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["-h", "--help"].includes(argument)) { process.stdout.write(usage); return; }
    if (argument === "--package") packagePath = resolve(args[++index] || "");
    else if (argument === "--publisher") publisher = args[++index] || "";
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--allow-test-certificate") allowTestCertificate = true;
    else throw cliError(`Unknown option: ${argument}\n${usage}`);
  }
  if (platform.id !== "win32") throw cliError("[ERROR] Windows package installation requires Windows.", 1);
  if (!packagePath || !publisher) throw cliError(`[ERROR] --package and --publisher are required.\n${usage}`, 1);
  if (!statSync(packagePath, { throwIfNoEntry: false })?.isFile() || !existsSync(`${packagePath}.sha256`)) {
    throw cliError(`[ERROR] MSIX or adjacent checksum was not found: ${packagePath}`, 1);
  }
  if (allowTestCertificate && publisher !== "CN=Meetron Local Test") {
    throw cliError("[ERROR] --allow-test-certificate is restricted to CN=Meetron Local Test.", 1);
  }
  const verify = await run(process.execPath, [
    resolve(repoRoot, "src/cli/verify-windows-release.mjs"),
    "--msix", packagePath, "--publisher", publisher,
    allowTestCertificate ? "--allow-test-signature" : "--require-release",
  ], { env: { ...process.env, MEETRON_PLATFORM: "win32" } });
  process.stdout.write(verify.stdout);
  const paths = platform.paths.resolve({ repoRoot, home: process.env.HOME || homedir(), env: process.env });
  const before = snapshotProfile(paths.dedicatedProfileDir);
  if (dryRun || process.env.MEETRON_WINDOWS_INSTALL_MOCK === "1") {
    process.stdout.write(`[${dryRun ? "DRY RUN" : "TEST"}] Verified Windows would install ${basename(packagePath)} in place.\n`);
    return;
  }
  const script = [
    "Add-AppxPackage -Path $env:MEETRON_MSIX_PATH -ForceApplicationShutdown -ErrorAction Stop",
    "$package = Get-AppxPackage -Name 'io.github.bb8ad8.meetron' -ErrorAction Stop",
    "$package.InstallLocation",
  ].join("; ");
  const powershell = resolve(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const { stdout } = await run(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
  ], { env: { ...process.env, MEETRON_MSIX_PATH: packagePath }, timeout: 120_000 });
  const installedRoot = stdout.trim().split(/\r?\n/).at(-1)?.trim() || "";
  if (!statSync(resolve(installedRoot, "runtime/node.exe"), { throwIfNoEntry: false })?.isFile()) {
    throw cliError("[ERROR] Windows installed the package but its bundled Node runtime was not found.", 1);
  }
  await run(resolve(installedRoot, "runtime/node.exe"), [
    resolve(installedRoot, "src/cli/install-control-ui.mjs"), "--quiet",
  ], { cwd: installedRoot, env: { ...process.env, MEETRON_PACKAGED: "1", MEETRON_PLATFORM: "win32" }, timeout: 60_000 });
  const after = snapshotProfile(paths.dedicatedProfileDir);
  if (before.existed && (!after.existed || before.localStateHash !== after.localStateHash)) {
    throw cliError("[ERROR] The dedicated Chrome profile or its login-state file changed during the package update.", 1);
  }
  process.stdout.write(`[OK] Installed ${basename(packagePath)} in place and refreshed Native Messaging registration.\n[OK] Dedicated Chrome profile and login state were preserved.\n`);
});
