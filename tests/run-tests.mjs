#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformAdapter } from "../src/platform/platform-registry.mjs";
import { findChromeExecutable } from "./chrome-fixture.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const portable = [
  "platform-contract-test.mjs",
  "credential-store-test.mjs",
  "audio-backend-test.mjs",
  "webrtc-loopback-contract-test.mjs",
  "protocol-test.mjs",
  "session-state-test.mjs",
  "session-orchestrator-test.mjs",
  "provider-contract-test.mjs",
  "preparation-contract-test.mjs",
  "service-worker-test.mjs",
  "meeting-browser-test.mjs",
  "playwright-cdp-test.mjs",
  "launch-secret-transport-test.mjs",
  "cli-test.mjs",
  "updater-test.mjs",
  "windows-package-test.mjs",
  "native-host-test.mjs",
  "session-cancel-test.mjs",
];
const macOnly = ["dco-test.mjs"];
const windowsOnly = ["windows-platform-test.mjs"];
const browser = [
  "extension-ui-test.mjs",
  "chatgpt-web-test.mjs",
  "unified-profile-test.mjs",
  "set-meet-mic-test.mjs",
  "prepare-meet-test.mjs",
  "zoom-web-provider-test.mjs",
  "prepare-zoom-test.mjs",
  "webrtc-loopback-browser-test.mjs",
];
const tests = [...portable];
if (process.platform === "darwin") tests.push(...macOnly);
if (process.platform === "win32") tests.push(...windowsOnly);
// The browser suite used to be locked to darwin by a hard-coded Chrome path,
// which left the Windows port with no browser coverage. Gate it on whether
// Chrome is actually present instead of on which platform this is.
if (process.env.MEETING_COPILOT_SKIP_BROWSER_TEST !== "1" && findChromeExecutable()) {
  tests.push(...browser);
}
let failures = 0;
for (const test of tests) {
  const result = getPlatformAdapter().process.spawnSync(process.execPath, [resolve(repoRoot, "tests", test)], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, MEETRON_PLATFORM: process.platform },
  });
  if (result.status === 0) {
    process.stdout.write(`[PASS] ${test}\n`);
  } else {
    failures += 1;
    process.stderr.write(`[FAIL] ${test}\n${result.stdout || ""}${result.stderr || ""}`);
  }
}
if (failures) {
  process.stderr.write(`${failures} test(s) failed.\n`);
  process.exit(1);
}
process.stdout.write("All tests passed.\n");
