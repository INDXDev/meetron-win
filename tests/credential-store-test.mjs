#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  loadProjectUrl,
  normalizeProjectUrl,
  projectSettingsInternals,
  saveProjectUrl,
} from "../src/platform/project-settings.mjs";
import {
  createWindowsCredentialStore,
  windowsCredentialStoreInternals,
} from "../src/platform/windows/windows-credential-store.mjs";

const calls = [];
let savedSecret = null;
const store = createWindowsCredentialStore({
  namespace: "test",
  invoke: async (command, target, input) => {
    calls.push({ command, target, input });
    if (command === "get") return { ok: true, found: savedSecret !== null, secret: savedSecret };
    if (command === "set") {
      savedSecret = input;
      return { ok: true };
    }
    const deleted = savedSecret !== null;
    savedSecret = null;
    return { ok: true, deleted };
  },
});
assert.equal(await store.get("missing"), null);
await store.set("project", "not-a-real-secret");
assert.equal(await store.get("project"), "not-a-real-secret");
assert.equal(await store.delete("project"), true);
assert.equal(calls[1].target, "Meetron:test:project");
assert.equal(calls[1].input, "not-a-real-secret");
assert.equal(windowsCredentialStoreInternals.targetName("community", "project"), "Meetron:community:project");
assert.throws(() => windowsCredentialStoreInternals.targetName("community", "../bad"));

assert.equal(
  normalizeProjectUrl("https://chatgpt.com/g/g-p-example/project?private=drop#fragment"),
  "https://chatgpt.com/g/g-p-example/project",
);
assert.throws(() => normalizeProjectUrl("https://example.com/g/g-p-example/project"));

const temporary = mkdtempSync(resolve(tmpdir(), "meetron-credentials-test-"));
try {
  const envPath = resolve(temporary, ".meeting-copilot.env");
  writeFileSync(envPath, [
    "MEETING_COPILOT_CDP_PORT=9223",
    "MEETING_COPILOT_CHATGPT_PROJECT_URL='https://chatgpt.com/g/g-p-legacy/project'",
    "",
  ].join("\n"));
  await saveProjectUrl({
    value: "https://chatgpt.com/g/g-p-vault/project?discard=true",
    platformId: "win32",
    repoRoot: temporary,
    envPath,
    credentialStore: store,
  });
  assert.equal(savedSecret, "https://chatgpt.com/g/g-p-vault/project");
  assert.doesNotMatch(readFileSync(envPath, "utf8"), /CHATGPT_PROJECT_URL/);
  assert.match(readFileSync(envPath, "utf8"), /MEETING_COPILOT_CDP_PORT=9223/);
  assert.equal(await loadProjectUrl({
    platformId: "win32",
    repoRoot: temporary,
    env: {},
    envPath,
    credentialStore: store,
  }), "https://chatgpt.com/g/g-p-vault/project");
  assert.equal(
    projectSettingsInternals.removeEnvironmentSetting(
      "MEETING_COPILOT_CHATGPT_PROJECT_URL='https://chatgpt.com/g/g-p-x/project'\nKEEP=1\n",
    ),
    "KEEP=1\n",
  );

  // A Credential Manager failure must degrade the status path to "not configured"
  // instead of taking session.status.get down, while a write must still fail loudly.
  const unavailable = () => {
    throw new Error("Credential Manager is unavailable");
  };
  const failingStore = { get: unavailable, set: unavailable, delete: unavailable };
  assert.equal(await loadProjectUrl({
    platformId: "win32",
    repoRoot: temporary,
    env: {},
    envPath,
    credentialStore: failingStore,
  }), "");
  const legacyPath = resolve(temporary, "legacy.env");
  writeFileSync(
    legacyPath,
    "MEETING_COPILOT_CHATGPT_PROJECT_URL='https://chatgpt.com/g/g-p-legacy/project'\n",
  );
  assert.equal(await loadProjectUrl({
    platformId: "win32",
    repoRoot: temporary,
    env: {},
    envPath: legacyPath,
    credentialStore: failingStore,
  }), "https://chatgpt.com/g/g-p-legacy/project");
  await assert.rejects(saveProjectUrl({
    value: "https://chatgpt.com/g/g-p-vault/project",
    platformId: "win32",
    repoRoot: temporary,
    envPath: legacyPath,
    credentialStore: failingStore,
  }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write("Windows credential store and project setting migration passed.\n");
