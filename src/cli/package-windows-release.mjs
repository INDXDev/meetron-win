#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import {
  cliError,
  distinguishedNamesMatch,
  repoRoot,
  run,
  runMain,
  runVisible,
} from "./cli-utils.mjs";
import { writeAppInstaller } from "./windows-appinstaller.mjs";

const IDENTITY_NAME = "io.github.bb8ad8.meetron";
const LOCAL_PUBLISHER = "CN=Meetron Local Test";
const usage = `Usage: node src/cli/package-windows-release.mjs [options]

Stages or packs the Windows x64 MSIX distribution.

Options:
  --local-test             Build an unsigned LOCAL-TEST artifact; dirty trees are allowed.
  --release                Fail-closed release mode; requires a clean tree and --publisher.
  --publisher SUBJECT      Certificate subject used by the MSIX identity.
  --publisher-name NAME    User-visible publisher name (default: certificate CN).
  --stage-only             Create the staging tree without packing it.
  --pack-stage DIRECTORY   Pack an existing, already-signed staging tree.
  --stage-dir DIRECTORY    Staging directory (required with --stage-only).
  --output-dir DIRECTORY   Artifact directory (default: dist/windows).
  --shell-dir DIRECTORY    Existing WinUI publish directory (implies --skip-build).
  --native-dir DIRECTORY   Existing Rust release directory (implies --skip-build).
  --node PATH              Node executable to bundle (default: current Node).
  --skip-build             Use existing native and shell build output.
  --package-uri URI        Emit an App Installer feed pointing at this MSIX URI.
  --appinstaller-uri URI   Stable, mutable URI the feed publishes itself at; its
                           filename becomes the emitted feed filename.
  --overwrite-appinstaller Replace an existing App Installer feed and checksum.
  --checksum PATH          Write PATH.sha256 for an already-signed artifact and exit.
`;

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function certificateCommonName(subject) {
  return subject.match(/(?:^|,\s*)CN=([^,]+)/i)?.[1]?.trim() || subject;
}

function packageVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw cliError(`[ERROR] Windows packaging requires a three-part numeric version: ${version}`, 1);
  }
  return `${version}.0`;
}

// The checksum is the only thing an offline installer can check, so it has to
// describe the bytes that actually ship. Packing happens before HSM signing,
// which rewrites the MSIX, so this is a separate step run after the signer.
function writeChecksum(path) {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw cliError(`[ERROR] Artifact to checksum was not found: ${path}`, 1);
  }
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(`${path}.sha256`, `${hash}  ${basename(path)}\n`);
  process.stdout.write(`[OK] Created ${path}.sha256\n`);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}

function solidPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  for (let pixel = 0; pixel < width; pixel += 1) {
    row[1 + pixel * 4] = 12;
    row[2 + pixel * 4] = 111;
    row[3 + pixel * 4] = 124;
    row[4 + pixel * 4] = 255;
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeAssets(stageRoot) {
  const assetRoot = resolve(stageRoot, "Assets");
  mkdirSync(assetRoot, { recursive: true });
  for (const [name, width, height] of [
    ["StoreLogo.png", 50, 50],
    ["Square44x44Logo.png", 44, 44],
    ["Square150x150Logo.png", 150, 150],
    ["Wide310x150Logo.png", 310, 150],
  ]) writeFileSync(resolve(assetRoot, name), solidPng(width, height));
}

function copyDirectory(source, destination) {
  if (!statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    throw cliError(`[ERROR] Required package directory was not found: ${source}`, 1);
  }
  cpSync(source, destination, {
    recursive: true,
    filter(path) {
      const name = basename(path);
      return ![".DS_Store", ".meeting-copilot.env", ".meeting-copilot-runtime"].includes(name) &&
        !/\.(?:log|p8|p12|pfx|cer|key)$/i.test(name);
    },
  });
}

function findShellOutput() {
  const candidates = [
    resolve(repoRoot, "native/windows-shell/bin/x64/Release/net8.0-windows10.0.19041.0/win-x64/publish"),
    resolve(repoRoot, "native/windows-shell/bin/x64/Release/net8.0-windows10.0.19041.0/win-x64"),
  ];
  return candidates.find((candidate) => existsSync(resolve(candidate, "Meetron.WindowsShell.exe"))) || "";
}

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

function renderManifest({ version, publisher, publisherName }) {
  let manifest = readFileSync(resolve(repoRoot, "native/windows-package/AppxManifest.xml.in"), "utf8");
  const replacements = {
    "@IDENTITY_NAME@": IDENTITY_NAME,
    "@PUBLISHER@": publisher,
    "@PUBLISHER_DISPLAY_NAME@": publisherName,
    "@VERSION@": packageVersion(version),
    "@ARCHITECTURE@": "x64",
  };
  for (const [placeholder, value] of Object.entries(replacements)) {
    manifest = manifest.replaceAll(placeholder, xmlEscape(value));
  }
  if (/@[A-Z_]+@/.test(manifest)) throw cliError("[ERROR] Unresolved Windows manifest placeholder.", 1);
  return manifest;
}

function assertStagedContracts(stageRoot) {
  for (const required of [
    "AppxManifest.xml",
    "Meetron.WindowsShell.exe",
    "runtime/node.exe",
    "native/windows/target/release/meetron-host.exe",
    "native/windows/target/release/meetron-audioctl.exe",
    "native/windows/target/release/meetron-credential.exe",
    "node_modules/playwright-core/package.json",
    "extension/manifest.json",
    "extension/service-worker.js",
    "extension/audio-bridge-content-script.js",
    "scripts/native-host.mjs",
    "src/cli/setup-meetron.mjs",
    "src/cli/update-meetron.mjs",
    "Meetron Setup.cmd",
    "Meetron Update.cmd",
  ]) {
    if (!statSync(resolve(stageRoot, required), { throwIfNoEntry: false })?.isFile()) {
      throw cliError(`[ERROR] Required Windows package path is missing: ${required}`, 1);
    }
  }
  const extension = JSON.parse(readFileSync(resolve(stageRoot, "extension/manifest.json"), "utf8"));
  const scripts = extension.content_scripts?.flatMap((entry) => entry.js || []) || [];
  const matches = extension.content_scripts?.flatMap((entry) => entry.matches || []) || [];
  if (!scripts.includes("audio-bridge-content-script.js") ||
      !matches.includes("https://chatgpt.com/*") ||
      !matches.includes("https://meet.google.com/*") ||
      !matches.includes("https://*.zoom.us/*")) {
    throw cliError("[ERROR] Phase 3 driverless extension manifest contracts were not staged.", 1);
  }
}

async function stagePackage({ stageRoot, shellDir, nativeDir, nodePath, skipBuild, manifest }) {
  if (existsSync(stageRoot)) throw cliError(`[ERROR] Refusing to overwrite staging directory: ${stageRoot}`, 1);
  mkdirSync(stageRoot, { recursive: true });
  if (!skipBuild) {
    await runVisible("cargo", ["build", "--manifest-path", "native/windows/Cargo.toml", "--release"]);
    const publishRoot = mkdtempSync(resolve(tmpdir(), "meetron-shell-publish-"));
    try {
      await runVisible("dotnet", [
        "publish", "native/windows-shell/Meetron.WindowsShell.csproj", "-c", "Release",
        "-p:Platform=x64", "--nologo", "-o", publishRoot,
      ]);
      shellDir = publishRoot;
      await copyStageFiles();
    } finally {
      rmSync(publishRoot, { recursive: true, force: true });
    }
    return;
  }
  await copyStageFiles();

  async function copyStageFiles() {
    const resolvedShell = shellDir || findShellOutput();
    const resolvedNative = nativeDir || resolve(repoRoot, "native/windows/target/release");
    if (!resolvedShell) throw cliError("[ERROR] WinUI output was not found. Run npm run build:windows or omit --skip-build.", 1);
    copyDirectory(resolvedShell, stageRoot);
    mkdirSync(resolve(stageRoot, "runtime"), { recursive: true });
    copyFileSync(nodePath, resolve(stageRoot, "runtime/node.exe"));
    for (const directory of ["src", "scripts", "extension"]) copyDirectory(resolve(repoRoot, directory), resolve(stageRoot, directory));
    copyDirectory(resolve(repoRoot, "node_modules/playwright-core"), resolve(stageRoot, "node_modules/playwright-core"));
    mkdirSync(resolve(stageRoot, "native/windows/target/release"), { recursive: true });
    for (const executable of ["meetron-host.exe", "meetron-audioctl.exe", "meetron-credential.exe"]) {
      const source = resolve(resolvedNative, executable);
      if (!existsSync(source)) throw cliError(`[ERROR] Windows helper was not found: ${source}`, 1);
      copyFileSync(source, resolve(stageRoot, "native/windows/target/release", executable));
    }
    for (const file of [
      "package.json", "package-lock.json", "LICENSE", "README.md", "SUPPORT.md", "SECURITY.md",
      "PRIVACY.md", "THIRD_PARTY_NOTICES.md", "Meetron Setup.cmd", "Meetron Update.cmd",
    ]) copyFileSync(resolve(repoRoot, file), resolve(stageRoot, file));
    writeFileSync(resolve(stageRoot, "AppxManifest.xml"), manifest, "utf8");
    writeAssets(stageRoot);
    assertStagedContracts(stageRoot);
  }
}

function emitAppInstaller({ outputDir, version, publisher, packageUri, appInstallerUri, artifactName, overwrite }) {
  if (!packageUri && !appInstallerUri) return;
  if (!packageUri || !appInstallerUri) {
    throw cliError("[ERROR] --package-uri and --appinstaller-uri must be supplied together.", 1);
  }
  const path = writeAppInstaller({
    outputDir,
    identityName: IDENTITY_NAME,
    publisher,
    version: packageVersion(version),
    architecture: "x64",
    artifactName,
    packageUri,
    appInstallerUri,
    overwrite,
  });
  process.stdout.write(`[OK] Created ${path}\n[OK] Created ${path}.sha256\n`);
}

runMain(async () => {
  let mode = "";
  let publisher = "";
  let publisherName = "";
  let stageOnly = false;
  let packStage = "";
  let stageDir = "";
  let outputDir = resolve(repoRoot, "dist/windows");
  let shellDir = "";
  let nativeDir = "";
  let nodePath = process.execPath;
  let skipBuild = false;
  let packageUri = "";
  let appInstallerUri = "";
  let overwriteAppInstaller = false;
  let checksumTarget = "";
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["-h", "--help"].includes(argument)) { process.stdout.write(usage); return; }
    if (["--local-test", "--release"].includes(argument)) {
      if (mode) throw cliError("[ERROR] Choose exactly one of --local-test or --release.", 1);
      mode = argument.slice(2);
    } else if (argument === "--publisher") publisher = args[++index] || "";
    else if (argument === "--publisher-name") publisherName = args[++index] || "";
    else if (argument === "--stage-only") stageOnly = true;
    else if (argument === "--pack-stage") packStage = resolve(args[++index] || "");
    else if (argument === "--stage-dir") stageDir = resolve(args[++index] || "");
    else if (argument === "--output-dir") outputDir = resolve(args[++index] || "");
    else if (argument === "--shell-dir") { shellDir = resolve(args[++index] || ""); skipBuild = true; }
    else if (argument === "--native-dir") { nativeDir = resolve(args[++index] || ""); skipBuild = true; }
    else if (argument === "--node") nodePath = resolve(args[++index] || "");
    else if (argument === "--skip-build") skipBuild = true;
    else if (argument === "--package-uri") packageUri = args[++index] || "";
    else if (argument === "--appinstaller-uri") appInstallerUri = args[++index] || "";
    else if (argument === "--overwrite-appinstaller") overwriteAppInstaller = true;
    else if (argument === "--checksum") checksumTarget = resolve(args[++index] || "");
    else throw cliError(`Unknown option: ${argument}\n${usage}`);
  }
  if (checksumTarget) {
    if (stageOnly || packStage) throw cliError("[ERROR] --checksum runs on its own, after the artifact has been signed.", 1);
    writeChecksum(checksumTarget);
    return;
  }
  if (!mode) throw cliError("[ERROR] Choose --local-test or --release.", 1);
  if (stageOnly === Boolean(packStage)) throw cliError("[ERROR] Choose exactly one of --stage-only or --pack-stage.", 1);
  if (stageOnly && !stageDir) throw cliError("[ERROR] --stage-only requires --stage-dir.", 1);
  if (!statSync(nodePath, { throwIfNoEntry: false })?.isFile()) throw cliError(`[ERROR] Node runtime was not found: ${nodePath}`, 1);
  if (mode === "release") {
    // Compared as parsed RDNs so that re-spaced, re-quoted, or reordered spellings
    // of the local test subject cannot slip past this as a release publisher.
    if (!publisher || distinguishedNamesMatch(publisher, LOCAL_PUBLISHER)) {
      throw cliError("[ERROR] Release packaging requires the HSM certificate publisher subject via --publisher.", 1);
    }
    const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
    if (dirty) throw cliError("[ERROR] Release MSIX packages require a clean Git worktree.", 1);
  } else publisher ||= LOCAL_PUBLISHER;
  publisherName ||= certificateCommonName(publisher);
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  const extension = JSON.parse(readFileSync(resolve(repoRoot, "extension/manifest.json"), "utf8"));
  if (pkg.name !== "meetron" || extension.name !== "Meetron Controls" || extension.version !== pkg.version) {
    throw cliError("[ERROR] package.json and extension/manifest.json versions are invalid or different.", 1);
  }
  const manifest = renderManifest({ version: pkg.version, publisher, publisherName });
  if (stageOnly) {
    await stagePackage({ stageRoot: stageDir, shellDir, nativeDir, nodePath, skipBuild, manifest });
    process.stdout.write(`[OK] Staged Windows package: ${stageDir}\n`);
    return;
  }
  assertStagedContracts(packStage);
  const stagedManifest = readFileSync(resolve(packStage, "AppxManifest.xml"), "utf8");
  const stagedPublisher = stagedManifest.match(/<Identity\s[^>]*\bPublisher="([^"]*)"/)?.[1]
    ?.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&") || "";
  if (!distinguishedNamesMatch(stagedPublisher, publisher) || !stagedManifest.includes(`Version="${packageVersion(pkg.version)}"`)) {
    throw cliError("[ERROR] Staged manifest identity does not match the requested package identity.", 1);
  }
  // The release stage is signed between --stage-only and --pack-stage by a
  // separate workflow step. Nothing else downstream re-checks it, so packing an
  // unsigned tree here would emit a release-named MSIX, checksum, and App
  // Installer feed that all look publishable. Fail closed instead of trusting
  // that the signing step ran.
  if (mode === "release") {
    await runVisible(process.execPath, [
      resolve(repoRoot, "src/cli/verify-windows-release.mjs"),
      "--stage", packStage, "--publisher", publisher, "--require-release",
    ]);
  }
  mkdirSync(outputDir, { recursive: true });
  const label = mode === "local-test" ? "-LOCAL-TEST" : "";
  const artifactName = `Meetron-${pkg.version}-windows-x64${label}.msix`;
  const artifactPath = resolve(outputDir, artifactName);
  if (existsSync(artifactPath) || existsSync(`${artifactPath}.sha256`)) {
    throw cliError(`[ERROR] Refusing to overwrite Windows artifact: ${artifactPath}`, 1);
  }
  const makeappx = findSdkTool("makeappx.exe");
  await run(makeappx, ["pack", "/d", packStage, "/p", artifactPath, "/o"]);
  emitAppInstaller({
    outputDir, version: pkg.version, publisher, packageUri, appInstallerUri,
    artifactName, overwrite: overwriteAppInstaller,
  });
  process.stdout.write(`[OK] Created ${artifactPath}\n`);
  // No checksum here: the MSIX is signed after packing, which rewrites it. Run
  // --checksum on the finished artifact so the published hash matches what ships.
  process.stdout.write(`[NEXT] Sign ${artifactName}, then run: npm run package:windows -- --checksum "${artifactPath}"\n`);
  if (mode === "local-test") process.stderr.write("[WARN] LOCAL-TEST MSIX is unsigned and must not be published.\n");
});
