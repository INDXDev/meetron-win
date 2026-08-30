#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { cliError, repoRoot, run, runMain } from "./cli-utils.mjs";

const usage = `Usage: node src/cli/package-community-release.mjs [options]

Creates a source-first Meetron Community ZIP.

Options:
  --audio-pkg PATH    Include and verify a notarized MeetronAudio-*.pkg.
  --output-dir DIR    Output directory (default: dist/community).
  --allow-dirty       Allow a dirty worktree for local packaging tests only.
  --dry-run           Validate inputs and print the planned artifact.
`;

const excludedTopLevel = new Set([
  ".git", "node_modules", "docs", "dist", ".meeting-copilot.env", ".meeting-copilot-runtime",
]);
const forbiddenName = (name) =>
  name === ".build" || name === ".DS_Store" || name.startsWith("._") ||
  /\.(?:log|p8|p12|cer|key|certSigningRequest)$/.test(name) ||
  /^id_(?:rsa|ed25519)/.test(name) || /^(?:credentials|cookies).*\.json$/.test(name) ||
  /^MeetronAudio-.*\.pkg(?:\.sha256)?$/.test(name);

function copyTree(source, destination, relativePath = "") {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!relativePath && excludedTopLevel.has(entry.name)) continue;
    if (forbiddenName(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to, relativePath ? join(relativePath, entry.name) : entry.name);
    else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function normalizeTimes(root) {
  const timestamp = new Date("2000-01-01T00:00:00Z");
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) normalizeTimes(path);
    utimesSync(path, timestamp, timestamp);
  }
  utimesSync(root, timestamp, timestamp);
}

async function verifyAudioPackage(path) {
  if (!existsSync(path)) throw cliError(`[ERROR] Audio package was not found: ${path}`, 1);
  if (!/^MeetronAudio-.*\.pkg$/.test(basename(path))) throw cliError(`[ERROR] Unexpected audio package name: ${basename(path)}`, 1);
  const checksumPath = `${path}.sha256`;
  if (!existsSync(checksumPath)) throw cliError(`[ERROR] Audio package checksum was not found: ${checksumPath}`, 1);
  const expected = readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (expected !== actual) throw cliError("[ERROR] Audio package checksum validation failed.", 1);
  const { stdout, stderr } = await run("pkgutil", ["--check-signature", path]);
  const signature = `${stdout}${stderr}`;
  if (!signature.includes("Developer ID Installer: Yuki Inaba") ||
      !signature.includes("Notarization: trusted by the Apple notary service")) {
    throw cliError("[ERROR] Audio package is not the expected signed and notarized release.", 1);
  }
  await run("spctl", ["--assess", "--type", "install", "--verbose=2", path]);
}

runMain(async () => {
  let audioPackage = "";
  let outputDir = resolve(repoRoot, "dist/community");
  let allowDirty = false;
  let dryRun = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["-h", "--help"].includes(argument)) { process.stdout.write(usage); return; }
    if (argument === "--audio-pkg") audioPackage = resolve(args[++index] || "");
    else if (argument === "--output-dir") outputDir = resolve(args[++index] || "");
    else if (argument === "--allow-dirty") allowDirty = true;
    else if (argument === "--dry-run") dryRun = true;
    else throw cliError(`Unknown option: ${argument}\n${usage}`);
  }
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  const extension = JSON.parse(readFileSync(resolve(repoRoot, "extension/manifest.json"), "utf8"));
  if (packageJson.name !== "meetron" || !/^\d+\.\d+\.\d+$/.test(packageJson.version) || extension.name !== "Meetron Controls" || extension.version !== packageJson.version) {
    throw cliError("[ERROR] package.json and extension/manifest.json versions are invalid or different.", 1);
  }
  const gitRoot = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (resolve(gitRoot) !== repoRoot) throw cliError("[ERROR] Community archives must be created from the Git repository root.", 1);
  const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
  if (dirty && !allowDirty) throw cliError("[ERROR] Public Community archives require a clean Git worktree.\nUse --allow-dirty only for a local test.", 1);
  if (audioPackage) await verifyAudioPackage(audioPackage);
  const label = allowDirty ? "Community-LOCAL-TEST" : "Community";
  if (allowDirty) process.stderr.write("[WARN] Dirty-worktree artifact is marked LOCAL-TEST and must not be published.\n");
  const archiveName = `Meetron-${packageJson.version}-${label}.zip`;
  if (dryRun) {
    process.stdout.write(`[DRY RUN] Community archive: ${resolve(outputDir, archiveName)}\n`);
    process.stdout.write(audioPackage ? `[DRY RUN] Include notarized audio package: ${audioPackage}\n` : "[DRY RUN] Source-only archive; no audio package selected.\n");
    return;
  }
  mkdirSync(outputDir, { recursive: true });
  const archivePath = resolve(outputDir, archiveName);
  if (existsSync(archivePath) || existsSync(`${archivePath}.sha256`)) throw cliError(`[ERROR] Refusing to overwrite an existing Community artifact: ${archivePath}`, 1);
  const stageParent = mkdtempSync(resolve(tmpdir(), "meetron-community-"));
  try {
    const stageRoot = resolve(stageParent, `Meetron-${packageJson.version}-${label}`);
    copyTree(repoRoot, stageRoot);
    if (audioPackage) {
      copyFileSync(audioPackage, resolve(stageRoot, basename(audioPackage)));
      const checksum = createHash("sha256").update(readFileSync(audioPackage)).digest("hex");
      writeFileSync(resolve(stageRoot, `${basename(audioPackage)}.sha256`), `${checksum}  ${basename(audioPackage)}\n`);
    }
    for (const required of ["Meetron Setup.command", "Meetron Update.command", "src/cli/setup-meetron.mjs", "src/cli/update-meetron.mjs"]) {
      if (!existsSync(resolve(stageRoot, required))) throw cliError(`[ERROR] Required release path was not staged: ${required}`, 1);
    }
    normalizeTimes(stageRoot);
    await run("zip", ["-X", "-q", "-r", archivePath, basename(stageRoot)], { cwd: stageParent });
    const checksum = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    writeFileSync(`${archivePath}.sha256`, `${checksum}  ${archiveName}\n`);
  } finally {
    rmSync(stageParent, { recursive: true, force: true });
  }
  process.stdout.write(`[OK] Created ${archivePath}\n[OK] Created ${archivePath}.sha256\n`);
});
