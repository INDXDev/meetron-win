#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { cliError, platform, run, runMain } from "./cli-utils.mjs";

const usage = `Usage: node src/cli/verify-windows-release.mjs [options]

Options:
  --msix PATH             Verify a packed MSIX and its adjacent checksum.
  --stage DIRECTORY       Verify staged inner binaries before MakeAppx runs.
  --publisher SUBJECT     Required Authenticode/MSIX publisher subject.
  --require-release       Require trusted signatures and reject LOCAL-TEST content.
  --allow-unsigned        Validate a LOCAL-TEST package structure without signatures.
  --allow-test-signature  Verify a trusted self-signed LOCAL-TEST package (Windows only).
  --appinstaller PATH     Also validate its checksum and package identity.
`;

function findSdkTool(name) {
  const override = process.env[`MEETRON_${name.replace(/\.exe$/i, "").toUpperCase()}_PATH`];
  if (override && existsSync(override)) return override;
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
    .filter(Boolean)
    .map((root) => resolve(root, "Windows Kits/10/bin"));
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root).sort().reverse()) {
      const candidate = resolve(root, version, "x64", name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return name;
}

function verifyChecksum(path) {
  const checksumPath = `${path}.sha256`;
  if (!existsSync(checksumPath)) throw cliError(`[ERROR] Checksum is missing: ${checksumPath}`, 1);
  const fields = readFileSync(checksumPath, "utf8").trim().split(/\s+/);
  const expected = fields[0]?.toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/.test(expected || "") || fields.at(-1) !== basename(path)) {
    throw cliError(`[ERROR] Invalid checksum file: ${checksumPath}`, 1);
  }
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expected) throw cliError(`[ERROR] SHA-256 mismatch: ${path}`, 1);
}

function walkFiles(root, output = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) walkFiles(path, output);
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function manifestIdentity(root) {
  const manifest = readFileSync(resolve(root, "AppxManifest.xml"), "utf8");
  const identity = manifest.match(/<Identity\s+[^>]*Name="([^"]+)"[^>]*Publisher="([^"]+)"[^>]*Version="([^"]+)"[^>]*ProcessorArchitecture="([^"]+)"/);
  if (!identity) throw cliError("[ERROR] MSIX identity could not be read.", 1);
  return { name: identity[1], publisher: identity[2].replaceAll("&quot;", '"').replaceAll("&amp;", "&"), version: identity[3], architecture: identity[4] };
}

function assertPackageContracts(root, { release }) {
  for (const required of [
    "Meetron.WindowsShell.exe",
    "runtime/node.exe",
    "native/windows/target/release/meetron-host.exe",
    "native/windows/target/release/meetron-audioctl.exe",
    "native/windows/target/release/meetron-credential.exe",
    "node_modules/playwright-core/package.json",
    "extension/audio-bridge-content-script.js",
    "extension/service-worker.js",
    "src/cli/setup-meetron.mjs",
    "src/cli/update-meetron.mjs",
  ]) {
    if (!statSync(resolve(root, required), { throwIfNoEntry: false })?.isFile()) {
      throw cliError(`[ERROR] Required packaged path is missing: ${required}`, 1);
    }
  }
  const manifest = readFileSync(resolve(root, "AppxManifest.xml"), "utf8");
  if (!/Category="windows\.startupTask"/.test(manifest) || !/TaskId="MeetronStartup"/.test(manifest)) {
    throw cliError("[ERROR] MSIX StartupTask declaration is missing.", 1);
  }
  const extension = JSON.parse(readFileSync(resolve(root, "extension/manifest.json"), "utf8"));
  if (extension.key !== "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuoAvvccpOLZ0grfX2yM/i1UoNIRaopU8R0o9h74CKzsts5uFPdWNw1qcKSCvoWIErzeygLEF29Zc4fyHhu9biIakEZWB23qFqACjiOjBI1YOZvf6L3odyQcO1EGAc9v0N3WLOSu2o7iDKaLY3xeCQx82r/6eQRbDH3Axkuw4YP0EbUquviCTTvnRvIOwW8bZCyCSyWRT6hj/xQYJAiT7PkxIxZNdpQ/aciN4I/EsAes5d6rjGQ6yU2rDrTZKSvWr5dfpUEBJp881SBCfooCznELXwRw+NhC07rW/VphNZUHQSbKiYAj5jk9huUuXi1UmvDFIJtzIQDkofi/g5lrUDQIDAQAB") {
    throw cliError("[ERROR] Packaged extension key changed; its stable extension ID would be lost.", 1);
  }
  const scripts = extension.content_scripts?.flatMap((entry) => entry.js || []) || [];
  if (!scripts.includes("audio-bridge-content-script.js")) {
    throw cliError("[ERROR] Phase 3 driverless bridge is missing from the packaged extension.", 1);
  }
  if (release && walkFiles(root).some((path) => /LOCAL-TEST/i.test(basename(path)))) {
    throw cliError("[ERROR] Release staging tree contains LOCAL-TEST content.", 1);
  }
}

async function signature(path) {
  const command = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
    "[pscustomobject]@{ Status = [string]$signature.Status; Subject = [string]$signature.SignerCertificate.Subject; Timestamp = [string]$signature.TimeStamperCertificate.Subject } | ConvertTo-Json -Compress",
  ].join("; ");
  const shell = process.env.SystemRoot
    ? resolve(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe")
    : "powershell.exe";
  const { stdout } = await run(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command, path]);
  return JSON.parse(stdout.trim());
}

async function verifySignature(path, publisher, { requireTimestamp = true } = {}) {
  const result = await signature(path);
  if (result.Status !== "Valid" || result.Subject !== publisher || (requireTimestamp && !result.Timestamp)) {
    throw cliError(`[ERROR] Trusted timestamped Authenticode signature is invalid for ${path} (status=${result.Status}, subject=${result.Subject || "none"}).`, 1);
  }
  const signtool = findSdkTool("signtool.exe");
  await run(signtool, ["verify", "/pa", "/all", "/v", path]);
}

async function verifyStage(root, { publisher, release, signed = release }) {
  assertPackageContracts(root, { release });
  const identity = manifestIdentity(root);
  if (identity.name !== "io.github.bb8ad8.meetron" || identity.architecture !== "x64") {
    throw cliError("[ERROR] Unexpected Windows package identity or architecture.", 1);
  }
  if (publisher && identity.publisher !== publisher) throw cliError("[ERROR] Manifest publisher does not match --publisher.", 1);
  if (signed) {
    const binaries = walkFiles(root).filter((path) => /\.(?:exe|dll)$/i.test(path));
    if (!binaries.length) throw cliError("[ERROR] Staging tree has no signable binaries.", 1);
    for (const binary of binaries) await verifySignature(binary, publisher, { requireTimestamp: release });
  }
  return identity;
}

function verifyAppInstaller(path, identity, msixPath) {
  verifyChecksum(path);
  const source = readFileSync(path, "ascii");
  for (const expected of [
    `Name="${identity.name}"`, `Publisher="${identity.publisher.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`,
    `Version="${identity.version}"`, `ProcessorArchitecture="${identity.architecture}"`,
  ]) if (!source.includes(expected)) throw cliError(`[ERROR] App Installer identity mismatch: ${expected}`, 1);
  if (!source.includes(`Uri="`) || !source.includes(basename(msixPath))) {
    throw cliError("[ERROR] App Installer does not reference the verified MSIX filename.", 1);
  }
}

runMain(async () => {
  let msix = "";
  let stage = "";
  let publisher = "";
  let release = false;
  let allowUnsigned = false;
  let allowTestSignature = false;
  let appInstaller = "";
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["-h", "--help"].includes(argument)) { process.stdout.write(usage); return; }
    if (argument === "--msix") msix = resolve(args[++index] || "");
    else if (argument === "--stage") stage = resolve(args[++index] || "");
    else if (argument === "--publisher") publisher = args[++index] || "";
    else if (argument === "--require-release") release = true;
    else if (argument === "--allow-unsigned") allowUnsigned = true;
    else if (argument === "--allow-test-signature") allowTestSignature = true;
    else if (argument === "--appinstaller") appInstaller = resolve(args[++index] || "");
    else throw cliError(`Unknown option: ${argument}\n${usage}`);
  }
  if (Boolean(msix) === Boolean(stage)) throw cliError("[ERROR] Choose exactly one of --msix or --stage.", 1);
  if ([release, allowUnsigned, allowTestSignature].filter(Boolean).length !== 1) {
    throw cliError("[ERROR] Choose exactly one signature policy.", 1);
  }
  if (release && !publisher) throw cliError("[ERROR] --require-release requires --publisher.", 1);
  if ((release || allowTestSignature) && platform.id !== "win32") throw cliError("[ERROR] Authenticode verification requires Windows.", 1);
  if (allowTestSignature && publisher !== "CN=Meetron Local Test") {
    throw cliError("[ERROR] Test-signature verification is restricted to CN=Meetron Local Test.", 1);
  }
  if (stage) {
    const identity = await verifyStage(stage, { publisher, release, signed: release || allowTestSignature });
    process.stdout.write(`[OK] Verified Windows package staging tree ${identity.version}.\n`);
    return;
  }
  if (!statSync(msix, { throwIfNoEntry: false })?.isFile()) throw cliError(`[ERROR] MSIX was not found: ${msix}`, 1);
  if (release && /LOCAL-TEST/i.test(basename(msix))) throw cliError("[ERROR] A LOCAL-TEST MSIX cannot pass release verification.", 1);
  if ((allowUnsigned || allowTestSignature) && !/LOCAL-TEST/i.test(basename(msix))) throw cliError("[ERROR] Local verification is allowed only for a LOCAL-TEST MSIX.", 1);
  verifyChecksum(msix);
  if (release || allowTestSignature) await verifySignature(msix, publisher, { requireTimestamp: release });
  const unpackRoot = mkdtempSync(resolve(tmpdir(), "meetron-msix-verify-"));
  try {
    const makeappx = findSdkTool("makeappx.exe");
    await run(makeappx, ["unpack", "/p", msix, "/d", unpackRoot, "/o"]);
    const identity = await verifyStage(unpackRoot, { publisher, release, signed: release || allowTestSignature });
    if (appInstaller) verifyAppInstaller(appInstaller, identity, msix);
    process.stdout.write(`[OK] Verified ${basename(msix)} (${identity.version}, ${release ? "signed release" : allowTestSignature ? "signed local test" : "unsigned local test"}).\n`);
  } finally {
    rmSync(unpackRoot, { recursive: true, force: true });
  }
});
