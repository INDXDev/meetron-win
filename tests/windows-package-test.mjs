#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { macosPlatformAdapter } from "../src/platform/macos/macos-platform-adapter.mjs";
import { assertUpdateFeedUris, distinguishedNamesMatch } from "../src/cli/cli-utils.mjs";
import {
  assertAppInstallerMatches,
  readAppInstaller,
  writeAppInstaller,
} from "../src/cli/windows-appinstaller.mjs";

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

  // A re-spaced spelling of the local test subject is the same publisher and
  // must not become releasable by reformatting.
  const respacedLocalPublisher = run("src/cli/package-windows-release.mjs", [
    "--release", "--publisher", 'CN = "Meetron Local Test"',
    "--stage-only", "--stage-dir", resolve(temporary, "respaced-stage"),
    "--shell-dir", shell, "--native-dir", native, "--node", process.execPath,
  ]);
  assert.equal(respacedLocalPublisher.status, 1);
  assert.match(respacedLocalPublisher.stderr, /requires the HSM certificate publisher subject/);

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
  const { version } = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  assert.ok(appxManifest.includes(`Version="${version}.0"`), `manifest must carry Version="${version}.0"`);
  assert.match(appxManifest, /<desktop6:RegistryWriteVirtualization>disabled</);
  assert.match(appxManifest, /Name="unvirtualizedResources"/);
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
  assert.match(verifyScript, /Set-Content.*-Encoding utf8/);
  assert.match(verifyScript, /WindowsPowerShell\/v1\.0\/powershell\.exe/);
  assert.doesNotMatch(verifyScript, /pwsh\.exe/);
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
  assert.match(packageInstaller, /IApplicationActivationManager/);
  assert.match(packageInstaller, /ActivateApplication/);
  assert.match(packageInstaller, /Package activation returned no process ID/);
  assert.doesNotMatch(packageInstaller, /shell:AppsFolder/);
  assert.match(packageInstaller, /waitForPackagedIntegration/);
  assert.match(packageInstaller, /Packaged Native Messaging refresh did not complete within 60 seconds/);
  assert.doesNotMatch(packageInstaller, /await run\(resolve\(installedRoot, "runtime\/node\.exe"\)/);
  if (process.platform === "win32") {
    const activatorSource = packageInstaller.match(/const PACKAGE_ACTIVATOR_SOURCE = String\.raw`\r?\n([\s\S]*?)`;/)?.[1];
    assert.ok(activatorSource, "embedded package activator source must be extractable");
    const command = `Add-Type -TypeDefinition @'\n${activatorSource}\n'@\n[Meetron.PackageActivator].FullName`;
    const result = spawnSync(
      resolve(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Meetron\.PackageActivator/);
  }
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

  // Certificate subjects arrive from three renderers, so the publisher check
  // compares parsed RDNs; it must forgive formatting and nothing else.
  assert.equal(distinguishedNamesMatch("CN=Meetron Local Test", 'CN = "Meetron Local Test"'), true);
  assert.equal(distinguishedNamesMatch("O=Meetron, CN=Release", "CN=Release, O=Meetron"), true);
  assert.equal(distinguishedNamesMatch("CN=Meetron Local Test", "CN=Meetron Local Tests"), false);
  assert.equal(distinguishedNamesMatch("CN=Release", "CN=Release, O=Meetron"), false);
  assert.equal(distinguishedNamesMatch("", "CN=Release"), false);

  const feedRepository = "bb8ad8/meetron";
  const feedBase = `https://github.com/${feedRepository}/releases`;
  const releaseArtifact = `Meetron-${version}-windows-x64.msix`;
  const releasePackageUri = `${feedBase}/download/v${version}/${releaseArtifact}`;
  const stableFeedUri = `${feedBase}/latest/download/Meetron.appinstaller`;
  const betaFeedUri = `${feedBase}/download/beta/Meetron-beta.appinstaller`;

  // Both channels have to stay reachable forever, so the feed's own URI may
  // never be pinned to the release tag it shipped with.
  assert.doesNotThrow(() => assertUpdateFeedUris({
    packageUri: releasePackageUri, appInstallerUri: stableFeedUri, repository: feedRepository,
  }));
  assert.doesNotThrow(() => assertUpdateFeedUris({
    packageUri: releasePackageUri, appInstallerUri: betaFeedUri, repository: feedRepository,
  }));
  assert.throws(() => assertUpdateFeedUris({
    packageUri: releasePackageUri,
    appInstallerUri: `${feedBase}/download/v${version}/Meetron.appinstaller`,
  }), /pinned to release tag/);
  assert.throws(() => assertUpdateFeedUris({
    packageUri: releasePackageUri.replace("https:", "http:"), appInstallerUri: stableFeedUri,
  }), /must use HTTPS/);
  assert.throws(() => assertUpdateFeedUris({
    packageUri: releasePackageUri, appInstallerUri: stableFeedUri.replace("github.com", "githubb.com"),
  }), /must be hosted on github\.com/);
  assert.throws(() => assertUpdateFeedUris({
    packageUri: releasePackageUri, appInstallerUri: `${feedBase}/latest/download/Meetron.txt`,
  }), /plain \.appinstaller filename/);
  assert.throws(() => assertUpdateFeedUris({
    packageUri: releasePackageUri,
    appInstallerUri: "https://github.com/attacker/meetron/releases/latest/download/Meetron.appinstaller",
  }), /must live in one repository/);
  assert.throws(() => assertUpdateFeedUris({
    packageUri: releasePackageUri, appInstallerUri: stableFeedUri, repository: "attacker/meetron",
  }), /must point at attacker\/meetron/);

  const feedDir = resolve(temporary, "feeds");
  mkdirSync(feedDir, { recursive: true });
  const identity = {
    name: "io.github.bb8ad8.meetron",
    publisher: "CN=Meetron Release, O=Meetron",
    version: `${version}.0`,
    architecture: "x64",
  };
  const feedInputs = {
    outputDir: feedDir,
    identityName: identity.name,
    publisher: identity.publisher,
    version: identity.version,
    artifactName: releaseArtifact,
    packageUri: releasePackageUri,
  };
  const stableFeed = writeAppInstaller({ ...feedInputs, appInstallerUri: stableFeedUri });
  const betaFeed = writeAppInstaller({ ...feedInputs, appInstallerUri: betaFeedUri });
  assert.equal(basename(stableFeed), "Meetron.appinstaller");
  assert.equal(basename(betaFeed), "Meetron-beta.appinstaller");
  for (const feed of [stableFeed, betaFeed]) assert.equal(existsSync(`${feed}.sha256`), true, feed);
  const stableDescriptor = readAppInstaller(stableFeed);
  const betaDescriptor = readAppInstaller(betaFeed);
  assert.equal(stableDescriptor.appInstallerUri, stableFeedUri);
  assert.equal(betaDescriptor.appInstallerUri, betaFeedUri);
  // Only the descriptor address is channel-specific; the MSIX stays version-pinned.
  assert.equal(stableDescriptor.packageUri, releasePackageUri);
  assert.equal(betaDescriptor.packageUri, releasePackageUri);
  assert.equal(betaDescriptor.version, identity.version);

  assert.throws(() => writeAppInstaller({ ...feedInputs, appInstallerUri: betaFeedUri }), /Refusing to overwrite App Installer feed/);
  assert.doesNotThrow(() => writeAppInstaller({ ...feedInputs, appInstallerUri: betaFeedUri, overwrite: true }));
  assert.throws(() => writeAppInstaller({
    ...feedInputs, appInstallerUri: `${feedBase}/download/v${version}/Meetron-tagged.appinstaller`,
  }), /pinned to release tag/);
  assert.throws(() => writeAppInstaller({
    ...feedInputs, artifactName: "Meetron-9.9.9-windows-x64.msix",
    appInstallerUri: `${feedBase}/latest/download/Meetron-other.appinstaller`,
  }), /must end in the packed artifact name/);

  assert.doesNotThrow(() => assertAppInstallerMatches(betaFeed, {
    identity, msixName: releaseArtifact, repository: feedRepository,
  }));
  assert.doesNotThrow(() => assertAppInstallerMatches(betaFeed, {
    identity: { ...identity, publisher: "O=Meetron, CN = Meetron Release" }, msixName: releaseArtifact,
  }));
  assert.throws(() => assertAppInstallerMatches(betaFeed, {
    identity: { ...identity, publisher: "CN=Meetron Local Test" }, msixName: releaseArtifact,
  }), /identity does not match/);
  assert.throws(() => assertAppInstallerMatches(betaFeed, {
    identity, msixName: "Meetron-9.9.9-windows-x64.msix",
  }), /does not reference the verified MSIX filename/);
  assert.throws(() => assertAppInstallerMatches(betaFeed, {
    identity, msixName: releaseArtifact, repository: "attacker/meetron",
  }), /must point at attacker\/meetron/);
  // A published descriptor is a separate file, so a hand-edited one must fail
  // the same URI rules the generator enforces.
  const tamperedFeed = resolve(feedDir, "Meetron-beta.appinstaller".replace(".appinstaller", "-tampered.appinstaller"));
  writeFileSync(tamperedFeed, readFileSync(betaFeed, "ascii").replaceAll("https://github.com", "https://evil.example"), "ascii");
  assert.throws(() => assertAppInstallerMatches(tamperedFeed, { identity, msixName: releaseArtifact }), /must be hosted on github\.com/);
  writeFileSync(tamperedFeed, readFileSync(betaFeed, "ascii").replace(betaFeedUri, stableFeedUri), "ascii");
  assert.throws(() => assertAppInstallerMatches(tamperedFeed, { identity, msixName: releaseArtifact }), /publishes itself as Meetron\.appinstaller/);

  const releaseWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/windows-release.yml"), "utf8");
  assert.match(releaseWorkflow, /BETA_CHANNEL_TAG: beta/);
  assert.match(releaseWorkflow, /Meetron-beta\.appinstaller/);
  assert.match(releaseWorkflow, /name: Refresh the mutable beta App Installer feed/);
  assert.match(releaseWorkflow, /gh release upload .*--clobber/s);
  assert.match(releaseWorkflow, /package:windows -- --checksum/);
  assert.doesNotMatch(releaseWorkflow, /Get-FileHash/);
  assert.match(releaseWorkflow, /--release-repository/);
  assert.match(ciWorkflow, /package:windows:local -- --checksum/);
  assert.doesNotMatch(ciWorkflow, /Get-FileHash/);
  assert.match(packageScript, /--checksum runs on its own, after the artifact has been signed/);
  assert.doesNotMatch(verifyScript, /\.\.\.process\.env/);
  assert.match(verifyScript, /powershellEnvironment\(/);
  assert.doesNotMatch(packageInstaller, /\.\.\.process\.env, MEETRON_MSIX_PATH/);
  assert.match(packageInstaller, /powershellEnvironment\(/);

  process.stdout.write("Windows MSIX staging, bundled runtime, startup, Phase 3, App Installer feed, and fail-closed release contracts passed.\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
