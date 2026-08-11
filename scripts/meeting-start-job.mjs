#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(repoRoot, ".meeting-copilot-runtime");
const statePath = resolve(runtimeDir, "meeting-launch.json");
const meetingUrl = process.argv[2];

function writeState(state) {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, statePath);
}

const baseState = {
  meetingUrl,
  pid: process.pid,
  startedAt: new Date().toISOString(),
};

writeState({ ...baseState, status: "running" });

const child = spawn(resolve(repoRoot, "scripts/start-meeting-copilot.sh"), [meetingUrl], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  writeState({
    ...baseState,
    status: "failed",
    finishedAt: new Date().toISOString(),
    error: error.message,
  });
  process.exit(1);
});

child.on("close", (code, signal) => {
  const succeeded = code === 0;
  writeState({
    ...baseState,
    status: succeeded ? "completed" : "failed",
    finishedAt: new Date().toISOString(),
    exitCode: code,
    signal,
    ...(!succeeded && { error: `起動処理が終了コード ${code ?? signal} で停止しました` }),
  });
  process.exit(succeeded ? 0 : 1);
});
