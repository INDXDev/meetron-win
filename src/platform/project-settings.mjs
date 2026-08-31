import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MeetronError } from "../core/errors.mjs";
import { getCredentialStore } from "./credential-store-registry.mjs";

export const PROJECT_URL_CREDENTIAL = "chatgpt-project-url";
const PROJECT_SETTING = "MEETING_COPILOT_CHATGPT_PROJECT_URL";

export function normalizeProjectUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new MeetronError("INVALID_PROJECT_URL", "Enter a valid ChatGPT Project URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "chatgpt.com" ||
    !/^\/g\/g-p-[A-Za-z0-9_-]+\/project\/?$/.test(url.pathname)
  ) {
    throw new MeetronError(
      "INVALID_PROJECT_URL",
      "Enter the ChatGPT Project /g/g-p-.../project URL",
    );
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function fromEnvironmentFile(path) {
  if (!existsSync(path)) return "";
  const escaped = PROJECT_SETTING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = readFileSync(path, "utf8").match(
    new RegExp(`^${escaped}=['\"]?([^'\"\\r\\n]+)['\"]?$`, "m"),
  );
  return match?.[1] || "";
}

function removeEnvironmentSetting(text) {
  return text
    .replace(/^MEETING_COPILOT_CHATGPT_PROJECT_URL=.*(?:\r?\n|$)/m, "")
    .replace(/^\s+$/, "");
}

export async function loadProjectUrl({
  platformId = process.platform,
  repoRoot,
  env = process.env,
  envPath = resolve(repoRoot, ".meeting-copilot.env"),
  credentialStore,
} = {}) {
  if (platformId === "win32") {
    try {
      const store = credentialStore || getCredentialStore(platformId, { repoRoot });
      const saved = await store.get(PROJECT_URL_CREDENTIAL);
      if (saved) return saved;
    } catch {
      // Reading runs on the session.status.get path, so a Credential Manager failure
      // has to degrade to "not configured" instead of taking the whole status
      // response down. saveProjectUrl still fails loudly, so a write is never lost.
      return fromEnvironmentFile(envPath);
    }
  }
  if (env[PROJECT_SETTING]) return env[PROJECT_SETTING];
  return fromEnvironmentFile(envPath);
}

export async function saveProjectUrl({
  value,
  platformId = process.platform,
  repoRoot,
  envPath = resolve(repoRoot, ".meeting-copilot.env"),
  credentialStore,
  secureFile = () => {},
} = {}) {
  const projectUrl = normalizeProjectUrl(value);
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  let updated;
  if (platformId === "win32") {
    const store = credentialStore || getCredentialStore(platformId, { repoRoot });
    await store.set(PROJECT_URL_CREDENTIAL, projectUrl);
    updated = removeEnvironmentSetting(existing);
  } else {
    const setting = `${PROJECT_SETTING}='${projectUrl}'`;
    updated = new RegExp(`^${PROJECT_SETTING}=.*$`, "m").test(existing)
      ? existing.replace(new RegExp(`^${PROJECT_SETTING}=.*$`, "m"), setting)
      : `${existing.trimEnd()}${existing.trim() ? "\n" : ""}${setting}\n`;
  }
  const temporaryPath = `${envPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, updated, { mode: 0o600 });
  renameSync(temporaryPath, envPath);
  secureFile(envPath);
  return projectUrl;
}

export const projectSettingsInternals = Object.freeze({
  fromEnvironmentFile,
  removeEnvironmentSetting,
});
