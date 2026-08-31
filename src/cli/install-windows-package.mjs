#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  cliError,
  distinguishedNamesMatch,
  platform,
  powershellEnvironment,
  repoRoot,
  run,
  runMain,
} from "./cli-utils.mjs";

const NATIVE_HOST_NAME = "com.meeting_copilot.host";
const NATIVE_HOST_MANIFEST = `${NATIVE_HOST_NAME}.json`;
const NATIVE_HOST_REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
const PACKAGE_ACTIVATOR_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;

namespace Meetron
{
    public static class PackageActivator
    {
        [Flags]
        private enum ActivateOptions
        {
            None = 0,
            NoErrorUi = 2
        }

        [ComImport]
        [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
        private class ApplicationActivationManager
        {
        }

        [ComImport]
        [Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IApplicationActivationManager
        {
            [PreserveSig]
            int ActivateApplication(
                [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
                [MarshalAs(UnmanagedType.LPWStr)] string arguments,
                ActivateOptions options,
                out uint processId);

            [PreserveSig]
            int ActivateForFile(
                [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
                IntPtr itemArray,
                [MarshalAs(UnmanagedType.LPWStr)] string verb,
                out uint processId);

            [PreserveSig]
            int ActivateForProtocol(
                [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
                IntPtr itemArray,
                out uint processId);
        }

        public static uint Activate(string appUserModelId)
        {
            var manager = (IApplicationActivationManager)new ApplicationActivationManager();
            try
            {
                uint processId;
                var result = manager.ActivateApplication(
                    appUserModelId,
                    null,
                    ActivateOptions.NoErrorUi,
                    out processId);
                if (result < 0)
                {
                    Marshal.ThrowExceptionForHR(result);
                }
                if (processId == 0)
                {
                    throw new InvalidOperationException("Package activation returned no process ID.");
                }
                return processId;
            }
            finally
            {
                if (Marshal.IsComObject(manager))
                {
                    Marshal.FinalReleaseComObject(manager);
                }
            }
        }
    }
}`;

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

async function waitForPackagedIntegration(paths, installedRoot, timeoutMs = 60_000) {
  const manifestPath = resolve(paths.nativeMessagingManifestDirs[0], NATIVE_HOST_MANIFEST);
  const expectedLauncher = platform.nativeHost.launcherPath({ runtimeDir: paths.runtimeDir });
  const configurationPath = resolve(paths.runtimeDir, "meetron-host.conf");
  const registry = resolve(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32/reg.exe");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const configuration = readFileSync(configurationPath, "utf8");
      const registered = await run(registry, ["query", NATIVE_HOST_REGISTRY_KEY, "/ve"], { timeout: 5_000 });
      if (
        resolve(manifest.path).toLowerCase() === resolve(expectedLauncher).toLowerCase()
        && statSync(expectedLauncher, { throwIfNoEntry: false })?.isFile()
        && configuration.toLowerCase().includes(resolve(installedRoot).toLowerCase())
        && registered.stdout.toLowerCase().includes(resolve(manifestPath).toLowerCase())
      ) return;
    } catch {
      // The packaged shell refreshes these files asynchronously after activation.
    }
    await delay(250);
  }
  throw cliError("[ERROR] Packaged Native Messaging refresh did not complete within 60 seconds.", 1);
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
  if (allowTestCertificate && !distinguishedNamesMatch(publisher, "CN=Meetron Local Test")) {
    throw cliError("[ERROR] --allow-test-certificate is restricted to CN=Meetron Local Test.", 1);
  }
  // The subject is a public string, so anyone can mint a self-signed certificate
  // that carries it. This flag only relaxes Meetron's own verification -- Windows
  // still refuses to deploy an untrusted signer -- but a command line alone must
  // not be enough to turn it on, or a pasted install command reads as verified.
  if (allowTestCertificate && process.env.MEETRON_ALLOW_TEST_CERT !== "1") {
    throw cliError("[ERROR] --allow-test-certificate also requires MEETRON_ALLOW_TEST_CERT=1; it is a CI-only path.", 1);
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
    "$package = @(Get-AppxPackage -Name 'io.github.bb8ad8.meetron' -ErrorAction Stop)",
    "if ($package.Count -ne 1) { throw \"Expected exactly one installed Meetron package, found $($package.Count).\" }",
    "'MEETRON_INSTALL_LOCATION=' + $package[0].InstallLocation",
    "'MEETRON_PACKAGE_FAMILY_NAME=' + $package[0].PackageFamilyName",
  ].join("; ");
  const powershell = resolve(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const { stdout } = await run(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
  ], { env: powershellEnvironment({ MEETRON_MSIX_PATH: packagePath }), timeout: 120_000 });
  const packageOutput = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const field = (name) => packageOutput.findLast((line) => line.startsWith(`${name}=`))?.slice(name.length + 1).trim() || "";
  const installedRoot = field("MEETRON_INSTALL_LOCATION");
  const packageFamilyName = field("MEETRON_PACKAGE_FAMILY_NAME");
  if (!installedRoot) throw cliError("[ERROR] Windows installed the package but its install location was not reported.", 1);
  if (!statSync(resolve(installedRoot, "runtime/node.exe"), { throwIfNoEntry: false })?.isFile()) {
    throw cliError("[ERROR] Windows installed the package but its bundled Node runtime was not found.", 1);
  }
  if (!packageFamilyName) throw cliError("[ERROR] Windows installed the package but its family name was not found.", 1);
  const activationScript = [
    "Add-Type -TypeDefinition @'",
    PACKAGE_ACTIVATOR_SOURCE,
    "'@",
    "$aumid = $env:MEETRON_PACKAGE_FAMILY + '!Meetron'",
    "$activatedProcessId = [Meetron.PackageActivator]::Activate($aumid)",
    "$activatedProcessId",
  ].join("\n");
  const { stdout: activationOutput } = await run(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", activationScript,
  ], { env: powershellEnvironment({ MEETRON_PACKAGE_FAMILY: packageFamilyName }), timeout: 30_000 });
  const activationPid = activationOutput.trim().split(/\r?\n/).findLast((line) => /^\d+$/.test(line.trim()))?.trim();
  if (!activationPid) throw cliError("[ERROR] Windows app-model activation returned no process ID.", 1);
  process.stdout.write(`[OK] Activated ${packageFamilyName}!Meetron as process ${activationPid}.\n`);
  await waitForPackagedIntegration(paths, installedRoot);
  const after = snapshotProfile(paths.dedicatedProfileDir);
  if (before.existed && (!after.existed || before.localStateHash !== after.localStateHash)) {
    throw cliError("[ERROR] The dedicated Chrome profile or its login-state file changed during the package update.", 1);
  }
  process.stdout.write(`[OK] Installed ${basename(packagePath)} in place and refreshed Native Messaging registration.\n[OK] Dedicated Chrome profile and login state were preserved.\n`);
});
