import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformAdapter } from "../platform/platform-registry.mjs";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const platform = getPlatformAdapter();
export const platformPaths = platform.paths.resolve({
  repoRoot,
  home: process.env.HOME || homedir(),
  env: process.env,
});
export const configurationPath = platform.id === "win32"
  ? resolve(platformPaths.runtimeDir, "../.meeting-copilot.env")
  : resolve(repoRoot, ".meeting-copilot.env");

export function loadEnvironment(path = configurationPath, env = process.env) {
  if (!existsSync(path)) return { ...env };
  const loaded = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1).replace(/'\\''/g, "'");
    }
    loaded[match[1]] = value;
  }
  return { ...loaded, ...env };
}

export function parseInteger(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!/^\d+$/.test(String(value ?? "")) || Number(value) < minimum || Number(value) > maximum) {
    const error = new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    error.exitCode = 2;
    throw error;
  }
  return Number(value);
}

export function cliError(message, exitCode = 2) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

// A certificate subject reaches us three ways -- typed into --publisher, read
// back from X509Certificate2.Subject, and stored in AppxManifest.xml -- and each
// renders the same identity with its own spacing, quoting, escaping, and
// attribute order. Comparing the rendered text therefore rejects identical
// publishers, so parse the RDN components and compare those instead.
export function parseDistinguishedName(subject) {
  const components = [];
  let type = "";
  let value = "";
  let quoted = false;
  let escaped = false;
  let readingType = true;
  const push = () => {
    if (type.trim()) components.push([type.trim().toUpperCase(), value.trim().replace(/\s+/g, " ")]);
    type = "";
    value = "";
    readingType = true;
  };
  for (const character of String(subject ?? "")) {
    if (escaped) { value += character; escaped = false; continue; }
    if (readingType) {
      if (character === "=") { readingType = false; continue; }
      if (character === "," || character === ";") { type = ""; continue; }
      type += character;
      continue;
    }
    if (character === "\\") { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && (character === "," || character === ";")) { push(); continue; }
    value += character;
  }
  push();
  return components;
}

// Attribute types are case-insensitive by specification, so they normalize;
// attribute values stay case-sensitive so this never accepts a publisher the
// raw comparison would have rejected on anything but formatting.
export function distinguishedNameKey(subject) {
  const components = parseDistinguishedName(subject);
  if (!components.length || components.some(([, value]) => !value)) return "";
  return components.map(([type, value]) => `${type}=${value}`).sort().join(",");
}

export function distinguishedNamesMatch(left, right) {
  const key = distinguishedNameKey(left);
  return Boolean(key) && key === distinguishedNameKey(right);
}

const RELEASE_URI_HOST = "github.com";

// Both the generator and the verifier have to agree on what a publishable
// release URI looks like, or the App Installer feed can be pointed somewhere
// Windows would still happily poll for the next "update".
export function parseReleaseUri(name, value) {
  let parsed;
  try { parsed = new URL(String(value ?? "")); } catch { throw cliError(`[ERROR] ${name} must be an absolute HTTPS URI.`, 1); }
  if (parsed.protocol !== "https:") throw cliError(`[ERROR] ${name} must use HTTPS.`, 1);
  if (parsed.host !== RELEASE_URI_HOST) {
    throw cliError(`[ERROR] ${name} must be hosted on ${RELEASE_URI_HOST} (found ${parsed.host || "none"}).`, 1);
  }
  let segments;
  try { segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { segments = []; }
  if (segments.length < 4 || segments[2] !== "releases") {
    throw cliError(`[ERROR] ${name} must be a ${RELEASE_URI_HOST} release asset URI.`, 1);
  }
  return {
    repository: `${segments[0]}/${segments[1]}`,
    // "" for the mutable /releases/latest/download alias, otherwise the release
    // tag the asset is pinned to.
    tag: segments[3] === "download" ? segments[4] || "" : "",
    fileName: segments.at(-1) || "",
  };
}

// A published App Installer feed is polled at exactly the URI baked into the
// installed package, forever. Pinning that URI to the release tag it shipped
// with freezes every installation on that build, so refuse to emit or accept it.
export function assertUpdateFeedUris({
  packageUri,
  appInstallerUri,
  repository = "",
  packageUriName = "--package-uri",
  appInstallerUriName = "--appinstaller-uri",
}) {
  const packageTarget = parseReleaseUri(packageUriName, packageUri);
  const feedTarget = parseReleaseUri(appInstallerUriName, appInstallerUri);
  if (packageTarget.repository !== feedTarget.repository) {
    throw cliError(`[ERROR] The MSIX and App Installer URIs must live in one repository (${packageTarget.repository} vs ${feedTarget.repository}).`, 1);
  }
  if (repository && packageTarget.repository !== repository) {
    throw cliError(`[ERROR] Release URIs must point at ${repository} (found ${packageTarget.repository}).`, 1);
  }
  if (feedTarget.tag && packageTarget.tag && feedTarget.tag === packageTarget.tag) {
    throw cliError(`[ERROR] The App Installer URI is pinned to release tag "${feedTarget.tag}"; that feed could never publish another update. Use a stable channel tag or the /releases/latest/download alias.`, 1);
  }
  if (!/^[A-Za-z0-9._-]+\.appinstaller$/.test(feedTarget.fileName)) {
    throw cliError(`[ERROR] ${appInstallerUriName} must end in a plain .appinstaller filename (found ${feedTarget.fileName || "none"}).`, 1);
  }
  return { packageTarget, feedTarget };
}

// PowerShell inherits whatever the caller exported, and these children read
// paths and credentials-adjacent state out of their environment. Hand them only
// the machine settings the shipped scripts actually need.
const POWERSHELL_ENVIRONMENT_KEYS = [
  "ALLUSERSPROFILE", "APPDATA", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432",
  "COMPUTERNAME", "ComSpec", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS",
  "OS", "Path", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "ProgramData",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PSModulePath", "PUBLIC", "SESSIONNAME",
  "SystemDrive", "SystemRoot", "TEMP", "TMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "windir",
];

export function powershellEnvironment(overrides = {}, env = process.env) {
  const minimal = {};
  for (const key of POWERSHELL_ENVIRONMENT_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== "") minimal[key] = value;
  }
  return { ...minimal, ...overrides };
}

export function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function run(command, args = [], options = {}) {
  return platform.process.run(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    ...options,
  });
}

export function runVisible(command, args = [], options = {}) {
  const { acceptedExitCodes = [0], ...spawnOptions } = options;
  const child = platform.process.spawn(command, args, {
    cwd: spawnOptions.cwd || repoRoot,
    env: spawnOptions.env || process.env,
    stdio: "inherit",
    ...spawnOptions,
  });
  return waitForChild(child, { acceptedExitCodes });
}

export function spawnNode(modulePath, args = [], options = {}) {
  return platform.process.spawn(process.execPath, [modulePath, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
}

export function waitForChild(child, { acceptedExitCodes = [0], input = null } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (acceptedExitCodes.includes(code)) {
        resolvePromise({ exitCode: code, signal });
      } else {
        const error = new Error(`Command stopped (${code ?? signal})`);
        error.exitCode = Number.isInteger(code) ? code : 1;
        rejectPromise(error);
      }
    });
    if (input !== null) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    }
  });
}

export async function runMain(main) {
  try {
    const exitCode = await main();
    if (Number.isInteger(exitCode)) process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode || 1;
  }
}

export function quoteCommand(values) {
  return values.map((value) => JSON.stringify(String(value))).join(" ");
}

export function versionAtLeast(installed, required) {
  const actual = String(installed).split(".").map(Number);
  const wanted = String(required).split(".").map(Number);
  if (actual.some((value) => !Number.isInteger(value)) || wanted.some((value) => !Number.isInteger(value))) return false;
  for (let index = 0; index < Math.max(actual.length, wanted.length, 3); index += 1) {
    if ((actual[index] || 0) > (wanted[index] || 0)) return true;
    if ((actual[index] || 0) < (wanted[index] || 0)) return false;
  }
  return true;
}
