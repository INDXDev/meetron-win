import { posix, win32 } from "node:path";
import { MeetronError } from "../core/errors.mjs";

const REQUIRED_PATH_FIELDS = Object.freeze([
  "runtimeDir",
  "dedicatedProfileDir",
  "legacyProfileDir",
]);

const REQUIRED_CAPABILITIES = Object.freeze({
  paths: ["resolve"],
  chrome: ["applications", "executable", "launch", "profileProcesses"],
  process: [
    "run", "runSync", "spawn", "spawnSync", "exists", "command",
    "terminate", "terminateTree", "commandEnvironment",
  ],
  net: ["listenerPid"],
  fsSecurity: ["secureDir", "secureFile"],
  nativeHost: ["installManifest", "uninstallManifest"],
  audioControl: ["executableCandidates", "fallbackExecutableCandidates"],
  shortcuts: [],
});

function assertCapability(adapterId, name, capability, methods) {
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
    throw new MeetronError(
      "INVALID_PLATFORM_ADAPTER",
      `Platform adapter ${adapterId} requires the ${name} capability group`,
    );
  }
  for (const method of methods) {
    if (typeof capability[method] !== "function") {
      throw new MeetronError(
        "INVALID_PLATFORM_ADAPTER",
        `Platform adapter ${adapterId} ${name} capability must implement ${method}()`,
      );
    }
  }
}

export function definePlatformAdapter(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new MeetronError("INVALID_PLATFORM_ADAPTER", "Platform adapter must be an object");
  }
  if (typeof definition.id !== "string" || !definition.id) {
    throw new MeetronError("INVALID_PLATFORM_ADAPTER", "Platform adapter id is required");
  }
  if (typeof definition.label !== "string" || !definition.label) {
    throw new MeetronError(
      "INVALID_PLATFORM_ADAPTER",
      `Platform adapter ${definition.id} requires a label`,
    );
  }
  for (const [name, methods] of Object.entries(REQUIRED_CAPABILITIES)) {
    assertCapability(definition.id, name, definition[name], methods);
  }
  if (typeof definition.shortcuts.meetingMute !== "string" || !definition.shortcuts.meetingMute) {
    throw new MeetronError(
      "INVALID_PLATFORM_ADAPTER",
      `Platform adapter ${definition.id} requires shortcuts.meetingMute`,
    );
  }
  return Object.freeze({
    ...definition,
    ...Object.fromEntries(
      Object.keys(REQUIRED_CAPABILITIES).map((name) => [name, Object.freeze({ ...definition[name] })]),
    ),
  });
}

export function isAbsolutePlatformPath(value) {
  return typeof value === "string" && (posix.isAbsolute(value) || win32.isAbsolute(value));
}

export function assertResolvedPlatformPaths(paths) {
  for (const field of REQUIRED_PATH_FIELDS) {
    if (!isAbsolutePlatformPath(paths?.[field])) {
      throw new MeetronError(
        "INVALID_PLATFORM_PATHS",
        `Platform path ${field} must be absolute`,
      );
    }
  }
  for (const field of ["chromeApplications", "nativeMessagingManifestDirs"]) {
    if (!Array.isArray(paths[field]) || paths[field].some((entry) => !isAbsolutePlatformPath(entry))) {
      throw new MeetronError(
        "INVALID_PLATFORM_PATHS",
        `${field} must contain absolute paths`,
      );
    }
  }
  return paths;
}
