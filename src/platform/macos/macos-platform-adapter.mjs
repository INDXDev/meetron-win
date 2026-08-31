import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  assertResolvedPlatformPaths,
  isAbsolutePlatformPath,
  definePlatformAdapter,
} from "../platform-contract.mjs";
import { MeetronError } from "../../core/errors.mjs";

const execFileAsync = promisify(execFile);

function requireAbsolute(name, value) {
  if (!isAbsolutePlatformPath(value)) {
    throw new MeetronError("INVALID_PLATFORM_CONTEXT", `${name} must be an absolute path`);
  }
  return value;
}

function resolvePaths({ repoRoot, home, env = process.env }) {
  const safeRepoRoot = requireAbsolute("repoRoot", repoRoot);
  const safeHome = requireAbsolute("home", home);
  const applicationSupport = posix.resolve(safeHome, "Library/Application Support");
  return assertResolvedPlatformPaths({
    runtimeDir: posix.resolve(
      env.MEETING_COPILOT_RUNTIME_DIR || posix.resolve(safeRepoRoot, ".meeting-copilot-runtime"),
    ),
    dedicatedProfileDir: posix.resolve(
      env.MEETING_COPILOT_PROFILE_DIR ||
        posix.resolve(applicationSupport, "MeetingCopilot/GPTParticipantChrome"),
    ),
    legacyProfileDir: posix.resolve(applicationSupport, "MeetingCopilot/ChatGPTVoiceChrome"),
    chromeApplications: [
      "/Applications/Google Chrome.app",
      posix.resolve(safeHome, "Applications/Google Chrome.app"),
    ],
    nativeMessagingManifestDirs: [
      posix.resolve(applicationSupport, "Google/Chrome/NativeMessagingHosts"),
      posix.resolve(
        env.MEETING_COPILOT_PROFILE_DIR ||
          posix.resolve(applicationSupport, "MeetingCopilot/GPTParticipantChrome"),
        "NativeMessagingHosts",
      ),
    ],
  });
}

async function listProcesses() {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,command="], { timeout: 3_000 });
  return stdout
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter(Boolean);
}

async function processCommand(pid) {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      timeout: 2_000,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminate(pid, signal = "SIGTERM") {
  process.kill(pid, signal);
}

function terminateTree(pid, signal = "SIGTERM") {
  try {
    process.kill(-pid, signal);
  } catch (groupError) {
    try {
      process.kill(pid, signal);
    } catch {
      if (groupError.code !== "ESRCH") throw groupError;
    }
  }
}

const processCapability = {
  run(command, args = [], options = {}) {
    return execFileAsync(command, args, options);
  },
  runSync(command, args = [], options = {}) {
    return execFileSync(command, args, options);
  },
  spawn(command, args = [], options = {}) {
    return spawn(command, args, options);
  },
  spawnSync(command, args = [], options = {}) {
    return spawnSync(command, args, options);
  },
  exists: processExists,
  command: processCommand,
  list: listProcesses,
  terminate,
  terminateTree,
  commandEnvironment({ env = process.env, nodePath = "" } = {}) {
    const paths = [
      nodePath ? dirname(nodePath) : "",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      env.PATH || "",
    ].filter(Boolean);
    return { ...env, PATH: paths.join(":") };
  },
};

async function profileProcesses(profileDir) {
  const profileArgument = `--user-data-dir=${profileDir}`;
  return (await listProcesses()).filter(
    ({ command }) =>
      command.includes(profileArgument) &&
      command.includes("/Contents/MacOS/") &&
      !command.includes("/Helper"),
  );
}

export const macosPlatformAdapter = definePlatformAdapter({
  id: "darwin",
  label: "macOS",
  paths: { resolve: resolvePaths },
  chrome: {
    applications({ home, env = process.env }) {
      if (env.MEETING_COPILOT_CHROME_PATH) return [env.MEETING_COPILOT_CHROME_PATH];
      return resolvePaths({ repoRoot: "/", home, env }).chromeApplications;
    },
    executable(applicationPath) {
      const appName = posix.basename(applicationPath).replace(/\.app$/, "");
      return posix.resolve(applicationPath, "Contents/MacOS", appName);
    },
    launch(applicationPath, args = [], options = {}) {
      return spawn("/usr/bin/open", ["-na", applicationPath, "--args", ...args], options);
    },
    profileProcesses,
  },
  process: processCapability,
  net: {
    async listenerPid(port, host = "127.0.0.1") {
      try {
        const { stdout } = await execFileAsync(
          "/usr/sbin/lsof",
          ["-nP", "-t", `-iTCP@${host}:${port}`, "-sTCP:LISTEN"],
          { timeout: 3_000 },
        );
        // lsof -t prints one PID per line and a trailing newline. Number("")
        // is 0 and passes Number.isInteger, so blank lines must be rejected.
        return stdout
          .split("\n")
          .map((line) => Number(line.trim()))
          .find((pid) => Number.isInteger(pid) && pid > 0) ?? null;
      } catch {
        return null;
      }
    },
  },
  fsSecurity: {
    secureDir(path) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
      return path;
    },
    secureFile(path) {
      chmodSync(path, 0o600);
      return path;
    },
  },
  nativeHost: {
    launcherPath({ runtimeDir }) {
      return resolve(runtimeDir, "native-host.mjs");
    },
    installLauncher({ runtimeDir, nodePath, scriptPath }) {
      const launcherPath = resolve(runtimeDir, "native-host.mjs");
      // The import specifier is resolved as a URL, so a bare file system path
      // breaks for a checkout whose path contains "#", "?", or "%".
      const specifier = pathToFileURL(scriptPath).href;
      writeFileSync(launcherPath, `#!${nodePath}\nimport ${JSON.stringify(specifier)};\n`, {
        mode: 0o700,
      });
      chmodSync(launcherPath, 0o700);
      return launcherPath;
    },
    installManifest({ manifest, directories, fileName }) {
      for (const directory of directories) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(resolve(directory, fileName), manifest, { mode: 0o600 });
      }
    },
    uninstallManifest({ directories, fileName }) {
      for (const directory of directories) {
        rmSync(resolve(directory, fileName), { force: true });
      }
    },
  },
  audioControl: {
    executableCandidates({ repoRoot, env = process.env }) {
      if (env.MEETING_COPILOT_AUDIOCTL !== undefined) return [env.MEETING_COPILOT_AUDIOCTL];
      return [
        posix.resolve(repoRoot, "native/audio-control/.build/apple/Products/Release/meetron-audioctl"),
        posix.resolve(repoRoot, "native/audio-control/.build/release/meeting-copilot-audioctl"),
        posix.resolve(repoRoot, "native/audio-control/.build/debug/meeting-copilot-audioctl"),
        "/usr/local/bin/meetron-audioctl",
        "/usr/local/bin/meeting-copilot-audioctl",
      ];
    },
    fallbackExecutableCandidates({ env = process.env } = {}) {
      if (env.MEETING_COPILOT_SWITCH_AUDIO_SOURCE !== undefined) {
        return [env.MEETING_COPILOT_SWITCH_AUDIO_SOURCE];
      }
      return ["/opt/homebrew/bin/SwitchAudioSource", "/usr/local/bin/SwitchAudioSource"];
    },
  },
  shortcuts: { meetingMute: "Meta+d" },
});
