#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformAdapter } from "../src/platform/platform-registry.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const portable = [
  "platform-contract-test.mjs",
  "audio-backend-test.mjs",
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
];
const macOnly = [
  "dco-test.mjs",
  "native-host-test.mjs",
  "session-cancel-test.mjs",
];
const windowsOnly = ["windows-platform-test.mjs"];
const browser = [
  "extension-ui-test.mjs",
  "chatgpt-web-test.mjs",
  "unified-profile-test.mjs",
  "set-meet-mic-test.mjs",
  "prepare-meet-test.mjs",
  "zoom-web-provider-test.mjs",
  "prepare-zoom-test.mjs",
];
const tests = [...portable];
if (process.platform === "darwin") tests.push(...macOnly);
if (process.platform === "win32") tests.push(...windowsOnly);
if (process.platform === "darwin" &&
    process.env.MEETING_COPILOT_SKIP_BROWSER_TEST !== "1" &&
    existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")) {
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
