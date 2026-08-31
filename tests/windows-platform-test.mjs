#!/usr/bin/env node

import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformAdapter } from "../src/platform/platform-registry.mjs";
import { windowsPlatformInternals } from "../src/platform/windows/windows-platform-adapter.mjs";
import { createWindowsCredentialStore } from "../src/platform/windows/windows-credential-store.mjs";

if (process.platform !== "win32") throw new Error("Windows platform tests require Windows.");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = getPlatformAdapter("win32");
const host = resolve(repoRoot, "native/windows/target/release/meetron-host.exe");
const audioctl = resolve(repoRoot, "native/windows/target/release/meetron-audioctl.exe");
const credentialHelper = resolve(repoRoot, "native/windows/target/release/meetron-credential.exe");
assert.equal(existsSync(host), true, "npm run build:windows must build meetron-host.exe");
assert.equal(existsSync(audioctl), true, "npm run build:windows must build meetron-audioctl.exe");
assert.equal(existsSync(credentialHelper), true, "npm run build:windows must build meetron-credential.exe");

const npm = platform.process.spawnSync("npm", ["--version"], { encoding: "utf8" });
assert.equal(npm.status, 0);
assert.match(npm.stdout.trim(), /^\d+\.\d+\.\d+$/);
assert.match(await platform.process.command(process.pid), /windows-platform-test\.mjs/);

const listener = createServer();
listener.unref();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
assert.equal(await platform.net.listenerPid(listener.address().port), process.pid);
await new Promise((resolveClose) => listener.close(resolveClose));

assert.equal(
  windowsPlatformInternals.commandLineArgument(
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="C:\\Users\\Meetron User\\Meetron Profile" --no-first-run',
    "user-data-dir",
  ),
  "C:\\Users\\Meetron User\\Meetron Profile",
);
// Node quotes the whole argument, not just the value, when a path has a space.
assert.equal(
  windowsPlatformInternals.commandLineArgument(
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "--user-data-dir=C:\\Users\\Meetron User\\Meetron Profile" --no-first-run',
    "user-data-dir",
  ),
  "C:\\Users\\Meetron User\\Meetron Profile",
);
assert.equal(
  windowsPlatformInternals.commandLineArgument(
    'chrome.exe --user-data-dir=C:\\Meetron\\Profile --no-first-run',
    "user-data-dir",
  ),
  "C:\\Meetron\\Profile",
);

const temporary = mkdtempSync(resolve(tmpdir(), "meetron-windows-test-"));
try {
  const credentialName = `phase2-test-${process.pid}`;
  const credentialStore = createWindowsCredentialStore({ repoRoot, namespace: "integration-test" });
  await credentialStore.delete(credentialName);
  try {
    assert.equal(await credentialStore.get(credentialName), null);
    await credentialStore.set(credentialName, "non-confidential-test-value");
    assert.equal(await credentialStore.get(credentialName), "non-confidential-test-value");
  } finally {
    assert.equal(await credentialStore.delete(credentialName), true);
  }

  const bridge = platform.process.spawnSync(
    process.execPath,
    [resolve(repoRoot, "src/cli/windows-shell-command.mjs"), "--request-stdin"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      input: JSON.stringify({ type: "ping" }),
      env: { ...process.env, MEETRON_PLATFORM: "win32" },
      timeout: 30_000,
    },
  );
  assert.equal(bridge.status, 0, bridge.stderr);
  const bridgeResponse = JSON.parse(bridge.stdout);
  assert.equal(bridgeResponse.ok, true);
  assert.equal(bridgeResponse.data.pong, true);

  const secureDirectory = resolve(temporary, "private");
  const secureFile = resolve(secureDirectory, "secret.txt");
  platform.fsSecurity.secureDir(secureDirectory);
  writeFileSync(secureFile, "not-a-real-secret\n");
  platform.fsSecurity.secureFile(secureFile);
  const acl = platform.process.spawnSync("icacls.exe", [secureFile], { encoding: "utf8" });
  assert.equal(acl.status, 0);
  assert.doesNotMatch(acl.stdout, /Everyone|BUILTIN\\Users|Authenticated Users/i);

  const version = platform.process.spawnSync(audioctl, ["version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.equal(JSON.parse(version.stdout).version, "0.1.0");
  const status = platform.process.spawnSync(audioctl, ["status"], { encoding: "utf8" });
  assert.equal(status.status, 0);
  const audio = JSON.parse(status.stdout);
  assert.equal(Array.isArray(audio.devices), true);
  assert.equal(audio.devices.every((device) => typeof device.uid === "string"), true);
  const thirdPartyRemoval = platform.process.spawnSync(
    process.execPath,
    [resolve(repoRoot, "src/cli/uninstall.mjs"), "--remove-audio-driver", "--yes"],
    { encoding: "utf8", env: { ...process.env, MEETRON_PLATFORM: "win32" } },
  );
  assert.equal(thirdPartyRemoval.status, 1);
  assert.match(thirdPartyRemoval.stderr, /does not own the third-party VB-CABLE driver/);

  if (process.env.MEETRON_TEST_NATIVE_REGISTRY === "1") {
    const registryKey = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.meeting_copilot.host";
    const manifestDirectory = resolve(temporary, "native-manifest");
    const fileName = "com.meeting_copilot.host.json";
    const before = platform.process.spawnSync("reg.exe", ["query", registryKey, "/ve"]);
    assert.notEqual(before.status, 0, "registry integration test refuses to replace an existing host");
    try {
      platform.nativeHost.installManifest({
        manifest: "{}\n",
        directories: [manifestDirectory],
        fileName,
      });
      const registered = platform.process.spawnSync(
        "reg.exe",
        ["query", registryKey, "/ve"],
        { encoding: "utf8" },
      );
      assert.equal(registered.status, 0);
      assert.match(registered.stdout, /com\.meeting_copilot\.host\.json/);
    } finally {
      platform.nativeHost.uninstallManifest({ directories: [manifestDirectory], fileName });
    }
  }

  const hostCopy = resolve(temporary, "meetron-host.exe");
  const hostConfig = resolve(temporary, "meetron-host.conf");
  const childScript = resolve(temporary, "job-child.mjs");
  const nativeScript = resolve(temporary, "job-parent.mjs");
  writeFileSync(childScript, "setInterval(() => {}, 1000);\n");
  writeFileSync(nativeScript, [
    'import { spawn } from "node:child_process";',
    `const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" });`,
    "process.stdout.write(`${child.pid}\\n`);",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  platform.nativeHost.installLauncher({
    repoRoot,
    runtimeDir: temporary,
    nodePath: process.execPath,
    scriptPath: nativeScript,
  });
  assert.equal(readFileSync(hostConfig, "utf8"), `${process.execPath}\r\n${nativeScript}\r\n`);
  writeFileSync(hostConfig, `C:\\missing-node\\node.exe\r\n${nativeScript}\r\n`);
  const shim = platform.process.spawn(hostCopy, [], { stdio: ["ignore", "pipe", "pipe"] });
  let line = "";
  shim.stdout.setEncoding("utf8");
  while (!line.includes("\n")) {
    const [chunk] = await once(shim.stdout, "data");
    line += chunk;
  }
  const childPid = Number(line.trim());
  assert.equal(platform.process.exists(childPid), true);
  platform.process.terminate(shim.pid, "SIGKILL");
  await once(shim, "close");
  for (let attempt = 0; attempt < 30 && platform.process.exists(childPid); attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.equal(platform.process.exists(childPid), false, "closing the host must kill its Job Object tree");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write("Windows adapter, ACL, MMDevice, and Job Object checks passed.\n");
