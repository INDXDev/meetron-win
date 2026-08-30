#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
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
  --allow-test-signature  Verify an integrity-valid self-signed LOCAL-TEST package (Windows only).
  --appinstaller PATH     Also validate its checksum and package identity.
`;

const TEST_SIGNED_BINARIES = [
  "Meetron.WindowsShell.exe",
  "Meetron.WindowsShell.dll",
  "native/windows/target/release/meetron-host.exe",
  "native/windows/target/release/meetron-audioctl.exe",
  "native/windows/target/release/meetron-credential.exe",
];
const TEST_VENDOR_BINARIES = ["runtime/node.exe"];

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

async function signatureSubjects(paths) {
  const inputRoot = mkdtempSync(resolve(tmpdir(), "meetron-signatures-"));
  const inputPath = resolve(inputRoot, "paths.json");
  writeFileSync(inputPath, JSON.stringify(paths), "utf8");
  const command = [
    "$paths = Get-Content -Raw -LiteralPath $env:MEETRON_SIGNATURE_PATHS | ConvertFrom-Json",
    "$subjects = foreach ($path in $paths) { $signature = Get-AuthenticodeSignature -LiteralPath $path; $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($path)); [pscustomobject]@{ Path = [string]$path; Subject = [string]$certificate.Subject; Status = [string]$signature.Status; StatusMessage = [string]$signature.StatusMessage } }",
    "$subjects | ConvertTo-Json -Compress",
  ].join("; ");
  const shell = process.env.SystemRoot
    ? resolve(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe")
    : "powershell.exe";
  try {
    const { stdout } = await run(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...process.env, MEETRON_SIGNATURE_PATHS: inputPath },
      timeout: 120_000,
    });
    const parsed = JSON.parse(stdout.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } finally {
    rmSync(inputRoot, { recursive: true, force: true });
  }
}

async function verifySignatures(paths, publisher, { requireTimestamp = true } = {}) {
  const subjects = await signatureSubjects(paths);
  if (subjects.length !== paths.length) throw cliError("[ERROR] Authenticode signer inventory is incomplete.", 1);
  for (const result of subjects) {
    if (result.Subject !== publisher) {
      throw cliError(`[ERROR] Authenticode signer subject does not match --publisher for ${result.Path} (subject=${result.Subject || "none"}).`, 1);
    }
  }
  await verifyTrustedSignatures(paths, { requireTimestamp });
}

async function verifyTestSignatures(paths, publisher) {
  const subjects = await signatureSubjects(paths);
  if (subjects.length !== paths.length) throw cliError("[ERROR] Authenticode signer inventory is incomplete.", 1);
  for (const result of subjects) {
    if (result.Subject !== publisher) {
      throw cliError(`[ERROR] Authenticode signer subject does not match --publisher for ${result.Path} (subject=${result.Subject || "none"}).`, 1);
    }
    if (result.Status === "Valid") continue;
    const untrustedSelfSigned = ["NotTrusted", "UnknownError"].includes(result.Status)
      && /(?:root certificate|certificate chain).*(?:not trusted|untrusted)/i.test(result.StatusMessage || "");
    if (!untrustedSelfSigned) {
      throw cliError(`[ERROR] LOCAL-TEST Authenticode integrity is invalid for ${result.Path} (status=${result.Status || "none"}).`, 1);
    }
  }
}

async function verifyTrustedSignatures(paths, { requireTimestamp = true } = {}) {
  const signtool = findSdkTool("signtool.exe");
  for (let offset = 0; offset < paths.length; offset += 24) {
    const batch = paths.slice(offset, offset + 24);
    const verification = await run(signtool, ["verify", "/pa", "/all", "/v", ...(requireTimestamp ? ["/tw"] : []), ...batch], {
      timeout: 120_000,
    });
    const output = `${verification.stdout}\n${verification.stderr}`;
    const timestampCount = output.match(/The signature is timestamped:/gi)?.length || 0;
    const warningCounts = [...output.matchAll(/Number of warnings:\s*(\d+)/gi)].map((match) => Number(match[1]));
    if (requireTimestamp && (timestampCount < batch.length || !warningCounts.length || warningCounts.some((count) => count !== 0))) {
      throw cliError(`[ERROR] Trusted timestamped Authenticode signature is invalid for batch starting with ${batch[0]}.`, 1);
    }
  }
}

async function verifyStage(root, { publisher, release, signed = release, testSignature = false }) {
  assertPackageContracts(root, { release });
  const identity = manifestIdentity(root);
  if (identity.name !== "io.github.bb8ad8.meetron" || identity.architecture !== "x64") {
    throw cliError("[ERROR] Unexpected Windows package identity or architecture.", 1);
  }
  if (publisher && identity.publisher !== publisher) throw cliError("[ERROR] Manifest publisher does not match --publisher.", 1);
  if (signed) {
    if (testSignature) {
      await verifyTestSignatures(
        TEST_SIGNED_BINARIES.map((path) => resolve(root, path)),
        publisher,
      );
      await verifyTrustedSignatures(
        TEST_VENDOR_BINARIES.map((path) => resolve(root, path)),
        { requireTimestamp: true },
      );
    } else {
      const binaries = walkFiles(root).filter((path) => /\.(?:exe|dll)$/i.test(path));
      if (!binaries.length) throw cliError("[ERROR] Staging tree has no signable binaries.", 1);
      await verifySignatures(binaries, publisher, { requireTimestamp: release });
    }
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
    const identity = await verifyStage(stage, {
      publisher,
      release,
      signed: release || allowTestSignature,
      testSignature: allowTestSignature,
    });
    process.stdout.write(`[OK] Verified Windows package staging tree ${identity.version}.\n`);
    return;
  }
  if (!statSync(msix, { throwIfNoEntry: false })?.isFile()) throw cliError(`[ERROR] MSIX was not found: ${msix}`, 1);
  if (release && /LOCAL-TEST/i.test(basename(msix))) throw cliError("[ERROR] A LOCAL-TEST MSIX cannot pass release verification.", 1);
  if ((allowUnsigned || allowTestSignature) && !/LOCAL-TEST/i.test(basename(msix))) throw cliError("[ERROR] Local verification is allowed only for a LOCAL-TEST MSIX.", 1);
  verifyChecksum(msix);
  if (release) await verifySignatures([msix], publisher, { requireTimestamp: true });
  else if (allowTestSignature) await verifyTestSignatures([msix], publisher);
  const unpackRoot = mkdtempSync(resolve(tmpdir(), "meetron-msix-verify-"));
  try {
    const makeappx = findSdkTool("makeappx.exe");
    await run(makeappx, ["unpack", "/p", msix, "/d", unpackRoot, "/o"]);
    const identity = await verifyStage(unpackRoot, {
      publisher,
      release,
      signed: release || allowTestSignature,
      testSignature: allowTestSignature,
    });
    if (appInstaller) verifyAppInstaller(appInstaller, identity, msix);
    process.stdout.write(`[OK] Verified ${basename(msix)} (${identity.version}, ${release ? "signed release" : allowTestSignature ? "signed local test" : "unsigned local test"}).\n`);
  } finally {
    rmSync(unpackRoot, { recursive: true, force: true });
  }
});
