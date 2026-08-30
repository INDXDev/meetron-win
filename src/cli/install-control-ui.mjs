#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import {
  cliError,
  platform,
  platformPaths,
  repoRoot,
  runMain,
} from "./cli-utils.mjs";

const EXTENSION_ID = "jlikakgdldiihhflkobhnpfegjlcakdd";
const MANIFEST_NAME = "com.meeting_copilot.host.json";
const usage = `Usage: node src/cli/install-control-ui.mjs [options]

Registers the Meetron Native Messaging Host for Google Chrome.

Options:
  --dry-run      Print the manifest without installing it.
  --uninstall    Remove the registered Native Messaging Host manifest.
  --quiet        Suppress setup instructions.
  -h, --help     Show this help.
`;

function availablePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.on("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

function updateSetting(text, name, value) {
  const quoted = `'${String(value).replaceAll("'", "'\\''")}'`;
  const setting = `${name}=${quoted}`;
  const expression = new RegExp(`^${name}=.*$`, "m");
  return expression.test(text)
    ? text.replace(expression, setting)
    : `${text.trimEnd()}${text.trim() ? "\n" : ""}${setting}\n`;
}

runMain(async () => {
  let dryRun = false;
  let uninstall = false;
  let quiet = false;
  for (const argument of process.argv.slice(2)) {
    if (["-h", "--help"].includes(argument)) { process.stdout.write(usage); return; }
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--uninstall") uninstall = true;
    else if (argument === "--quiet") quiet = true;
    else throw cliError(`Unknown option: ${argument}\n${usage}`);
  }
  const extensionDir = resolve(repoRoot, "extension");
  if (!existsSync(resolve(extensionDir, "manifest.json"))) throw cliError(`Extension manifest not found: ${resolve(extensionDir, "manifest.json")}`, 1);
  const directories = platformPaths.nativeMessagingManifestDirs;
  if (uninstall) {
    if (dryRun) {
      for (const directory of directories) process.stdout.write(`[DRY RUN] remove ${resolve(directory, MANIFEST_NAME)}\n`);
    } else {
      platform.nativeHost.uninstallManifest({ directories, fileName: MANIFEST_NAME });
      for (const directory of directories) process.stdout.write(`Removed Native Messaging Host manifest: ${resolve(directory, MANIFEST_NAME)}\n`);
    }
    return;
  }
  if (!existsSync(resolve(repoRoot, "node_modules/playwright-core"))) throw cliError("playwright-core is required. Run: npm ci", 1);
  const hostPath = resolve(platformPaths.runtimeDir, "native-host");
  const manifest = `${JSON.stringify({
    name: "com.meeting_copilot.host",
    description: "Meetron local control host",
    path: hostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  }, null, 2)}\n`;
  if (dryRun) {
    for (const directory of directories) process.stdout.write(`[DRY RUN] install ${resolve(directory, MANIFEST_NAME)}\n`);
    process.stdout.write(manifest);
    return;
  }
  platform.fsSecurity.secureDir(platformPaths.runtimeDir);
  const launcher = `#!${process.execPath}\nimport ${JSON.stringify(new URL("../../scripts/native-host.mjs", import.meta.url).href)};\n`;
  writeFileSync(hostPath, launcher, { mode: 0o700 });
  chmodSync(hostPath, 0o700);
  const envPath = resolve(repoRoot, ".meeting-copilot.env");
  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  text = updateSetting(text, "MEETING_COPILOT_NODE_PATH", process.execPath);
  if (!/^MEETING_COPILOT_CDP_PORT=/m.test(text)) {
    text += `MEETING_COPILOT_CDP_PORT=${await availablePort()}\n`;
  }
  text = text.replace(/^MEETING_COPILOT_CHATGPT_CDP_PORT=.*(?:\r?\n|$)/m, "");
  const temporary = `${envPath}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, envPath);
  platform.fsSecurity.secureFile(envPath);
  platform.nativeHost.installManifest({ manifest, directories, fileName: MANIFEST_NAME });
  process.stdout.write("Native Messaging Host installed.\n");
  for (const directory of directories) process.stdout.write(`  Manifest:  ${resolve(directory, MANIFEST_NAME)}\n`);
  process.stdout.write(`  Extension: ${extensionDir}\n  ID:        ${EXTENSION_ID}\n`);
  if (!quiet) {
    process.stdout.write(`\nLoad the controller extension from:\n\n  ${extensionDir}\n\nThen run: node src/cli/open-control-ui-setup.mjs\n`);
  }
});
