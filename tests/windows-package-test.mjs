#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { macosPlatformAdapter } from "../src/platform/macos/macos-platform-adapter.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(resolve(tmpdir(), "meetron-windows-package-test-"));
const shell = resolve(temporary, "shell");
const native = resolve(temporary, "native");
const stage = resolve(temporary, "stage");

function run(module, args) {
  return macosPlatformAdapter.process.spawnSync(process.execPath, [resolve(repoRoot, module), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, MEETRON_PLATFORM: "darwin" },
  });
}

try {
  mkdirSync(shell, { recursive: true });
  mkdirSync(native, { recursive: true });
  writeFileSync(resolve(shell, "Meetron.WindowsShell.exe"), "fixture shell\n");
  for (const executable of ["meetron-host.exe", "meetron-audioctl.exe", "meetron-credential.exe"]) {
    writeFileSync(resolve(native, executable), `fixture ${executable}\n`);
  }
  const missingPublisher = run("src/cli/package-windows-release.mjs", [
    "--release", "--stage-only", "--stage-dir", resolve(temporary, "release-stage"),
    "--shell-dir", shell, "--native-dir", native, "--node", process.execPath,
  ]);
  assert.equal(missingPublisher.status, 1);
  assert.match(missingPublisher.stderr, /requires the HSM certificate publisher subject/);

  const staged = run("src/cli/package-windows-release.mjs", [
    "--local-test", "--stage-only", "--stage-dir", stage,
    "--shell-dir", shell, "--native-dir", native, "--node", process.execPath,
  ]);
  assert.equal(staged.status, 0, staged.stderr || staged.stdout);
  for (const path of [
    "AppxManifest.xml", "runtime/node.exe", "Meetron.WindowsShell.exe",
    "extension/audio-bridge-content-script.js", "native/windows/target/release/meetron-host.exe",
    "node_modules/playwright-core/package.json", "Meetron Setup.cmd", "Meetron Update.cmd",
  ]) assert.equal(existsSync(resolve(stage, path)), true, path);
  const appxManifest = readFileSync(resolve(stage, "AppxManifest.xml"), "utf8");
  assert.match(appxManifest, /Category="windows\.startupTask"/);
  assert.match(appxManifest, /Publisher="CN=Meetron Local Test"/);
  assert.match(appxManifest, /Version="0\.10\.1\.0"/);
  assert.doesNotMatch(appxManifest, /@[A-Z_]+@/);

  const verified = run("src/cli/verify-windows-release.mjs", [
    "--stage", stage, "--allow-unsigned",
  ]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);

  const packageScript = readFileSync(resolve(repoRoot, "src/cli/package-windows-release.mjs"), "utf8");
  assert.match(packageScript, /Release MSIX packages require a clean Git worktree/);
  assert.match(packageScript, /audio-bridge-content-script\.js/);
  const verifyScript = readFileSync(resolve(repoRoot, "src/cli/verify-windows-release.mjs"), "utf8");
  assert.match(verifyScript, /Trusted timestamped Authenticode signature is invalid/);
  assert.match(verifyScript, /X509Certificate.*CreateFromSignedFile/);
  assert.match(verifyScript, /Get-AuthenticodeSignature/);
  assert.match(verifyScript, /Status\.ToString\(\)/);
  assert.match(verifyScript, /MEETRON_SIGNATURE_RESULT/);
  assert.match(verifyScript, /Set-Content.*utf8NoBOM/);
  assert.match(verifyScript, /run\("pwsh\.exe"/);
  assert.match(verifyScript, /LOCAL-TEST Authenticode integrity is invalid/);
  assert.match(verifyScript, /verifyTestSignatures/);
  assert.match(verifyScript, /offset \+= 24/);
  assert.match(verifyScript, /TEST_SIGNED_BINARIES/);
  assert.match(verifyScript, /TEST_VENDOR_BINARIES/);
  assert.match(verifyScript, /Meetron\.WindowsShell\.dll/);
  assert.match(verifyScript, /verifyTrustedSignatures/);
  assert.match(verifyScript, /testSignature: allowTestSignature/);
  assert.match(verifyScript, /LOCAL-TEST MSIX cannot pass release verification/);
  const packageInstaller = readFileSync(resolve(repoRoot, "src/cli/install-windows-package.mjs"), "utf8");
  assert.match(packageInstaller, /MEETRON_MSIX_PATH/);
  assert.match(packageInstaller, /timeout: 120_000/);
  assert.match(packageInstaller, /shell:AppsFolder/);
  assert.match(packageInstaller, /waitForPackagedIntegration/);
  assert.match(packageInstaller, /Packaged Native Messaging refresh did not complete within 60 seconds/);
  assert.doesNotMatch(packageInstaller, /await run\(resolve\(installedRoot, "runtime\/node\.exe"\)/);
  const integrationInstaller = readFileSync(resolve(repoRoot, "src/cli/install-control-ui.mjs"), "utf8");
  assert.match(integrationInstaller, /MEETRON_PACKAGED/);
  assert.match(integrationInstaller, /\.\.\/Extension/);
  const shellClient = readFileSync(resolve(repoRoot, "native/windows-shell/MeetronClient.cs"), "utf8");
  assert.match(shellClient, /runtime", "node\.exe/);
  assert.match(shellClient, /MEETRON_PACKAGED/);
  const ciWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(ciWorkflow, /creating disposable certificate/);
  assert.match(ciWorkflow, /Wait-Job \$certificateJob -Timeout 30/);
  assert.match(ciWorkflow, /X509Store/);
  assert.match(ciWorkflow, /'TrustedPeople'.*StoreLocation\]::LocalMachine/s);
  assert.match(ciWorkflow, /OpenFlags\]::ReadWrite/);
  assert.match(ciWorkflow, /FindByThumbprint/);
  assert.match(ciWorkflow, /\$cleanupStore\.Remove\(\$cleanupCertificate\)/);
  assert.match(ciWorkflow, /name: Sign and verify local Windows staging tree/);
  assert.match(ciWorkflow, /name: Pack, sign, and checksum local MSIX/);
  assert.match(ciWorkflow, /name: Install, update, and preserve Windows profile state/);
  assert.match(ciWorkflow, /if: always\(\) && runner\.os == 'Windows'/);

  process.stdout.write("Windows MSIX staging, bundled runtime, startup, Phase 3, and fail-closed release contracts passed.\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
