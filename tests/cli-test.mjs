#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { macosPlatformAdapter } from "../src/platform/macos/macos-platform-adapter.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = mkdtempSync(resolve(tmpdir(), "meetron-cli-test-"));

function node(modulePath, args = [], env = {}) {
  return macosPlatformAdapter.process.spawnSync(
    process.execPath,
    [resolve(repoRoot, modulePath), ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, MEETRON_PLATFORM: "darwin", ...env },
    },
  );
}

try {
  assert.deepEqual(readdirSync(resolve(repoRoot, "scripts")).filter((name) => name.endsWith(".sh")), []);
  const cliFiles = readdirSync(resolve(repoRoot, "src/cli")).filter((name) => name.endsWith(".mjs"));
  // Shared modules have no command line, and these two entry points act on the
  // real machine (Swift build, Native Host registration, Chrome launch) without
  // parsing --help, so they must never be started from the test suite.
  const notInvokable = new Set([
    "cli-utils.mjs", "chrome-session.mjs", "build-audio-control.mjs", "open-control-ui-setup.mjs",
  ]);
  for (const file of cliFiles) {
    if (notInvokable.has(file)) continue;
    const checked = node(`src/cli/${file}`, ["--help"]);
    assert.equal(checked.status, 0, `${file}: ${checked.stderr}`);
  }
  for (const directory of ["scripts", "src", "tests"]) {
    const walk = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = resolve(path, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith(".mjs")) {
          const checked = macosPlatformAdapter.process.spawnSync(process.execPath, ["--check", child], { encoding: "utf8" });
          assert.equal(checked.status, 0, `${child}: ${checked.stderr}`);
        }
      }
    };
    walk(resolve(repoRoot, directory));
  }
  const fakeChrome = resolve(temporary, "Google Chrome.app");
  mkdirSync(resolve(fakeChrome, "Contents/MacOS"), { recursive: true });
  writeFileSync(resolve(fakeChrome, "Contents/MacOS/Google Chrome"), "");
  const sharedEnv = {
    MEETING_COPILOT_CHROME_PATH: fakeChrome,
    MEETING_COPILOT_PROFILE_DIR: resolve(temporary, "profile"),
  };
  const meet = node("src/cli/open-gpt-participant.mjs", ["--dry-run", "https://meet.google.com/abc-defg-hij"], sharedEnv);
  assert.equal(meet.status, 0, meet.stderr);
  assert.match(meet.stdout, /--user-data-dir=/);
  const zoom = node("src/cli/open-gpt-participant.mjs", ["--dry-run", "https://us02web.zoom.us/j/12345678901?pwd=secret"], sharedEnv);
  assert.equal(zoom.status, 0, zoom.stderr);
  assert.match(zoom.stdout, /Provider:\s+Zoom Web App/);
  assert.match(zoom.stdout, /about:blank/);
  assert.doesNotMatch(zoom.stdout, /secret|us02web\.zoom\.us\/j/);
  const join = node("src/cli/open-gpt-participant.mjs", ["--join", "--join-delay", "7", "--dry-run", "https://meet.google.com/abc-defg-hij"], sharedEnv);
  assert.equal(join.status, 0, join.stderr);
  assert.match(join.stdout, /wait 7 seconds/);
  const chatgpt = node("src/cli/open-chatgpt-live.mjs", ["--restart-profile", "--dry-run"], {
    ...sharedEnv,
    MEETING_COPILOT_CDP_PORT: "9223",
    MEETING_COPILOT_CHATGPT_PROJECT_URL: "https://chatgpt.com/g/g-p-test/project",
  });
  assert.equal(chatgpt.status, 0, chatgpt.stderr);
  assert.match(chatgpt.stdout, /--remote-debugging-port=9223/);
  assert.match(chatgpt.stdout, /g-p-test\/project/);
  const unsupported = node("src/cli/open-gpt-participant.mjs", ["--dry-run", "http://example.com/not-a-meeting"], sharedEnv);
  assert.notEqual(unsupported.status, 0);
  const sourceImports = ["scripts", "src"].flatMap((directory) => {
    const found = [];
    const walk = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = resolve(path, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (/\.(?:mjs|js)$/.test(entry.name)) found.push(child);
      }
    };
    walk(resolve(repoRoot, directory));
    return found;
  });
  const illegal = sourceImports.filter((path) =>
    !path.includes(`${resolve(repoRoot, "src/platform")}\\`) &&
    !path.includes(`${resolve(repoRoot, "src/platform")}/`) &&
    /node:child_process/.test(readFileSync(path, "utf8")),
  );
  assert.deepEqual(illegal, []);
  process.stdout.write("Node CLI ports, syntax, dry runs, and platform-boundary enforcement passed.\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
