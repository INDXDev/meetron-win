import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import {
  assertResolvedPlatformPaths,
  definePlatformAdapter,
  isAbsolutePlatformPath,
} from "../platform-contract.mjs";
import { MeetronError } from "../../core/errors.mjs";

const execFileAsync = promisify(execFile);
const NATIVE_HOST_NAME = "com.meeting_copilot.host";
const NATIVE_HOST_REGISTRY_KEY =
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;

function requireAbsolute(name, value) {
  if (!isAbsolutePlatformPath(value)) {
    throw new MeetronError("INVALID_PLATFORM_CONTEXT", `${name} must be an absolute path`);
  }
  return value;
}

function windowsDirectory(env = process.env) {
  return env.SystemRoot || env.WINDIR || "C:\\Windows";
}

function systemExecutable(name, env = process.env) {
  return win32.resolve(windowsDirectory(env), "System32", name);
}

function powershellExecutable(env = process.env) {
  return systemExecutable("WindowsPowerShell\\v1.0\\powershell.exe", env);
}

function resolvePaths({ repoRoot, home, env = process.env }) {
  const safeRepoRoot = requireAbsolute("repoRoot", repoRoot);
  requireAbsolute("home", home);
  const localAppData = requireAbsolute(
    "LOCALAPPDATA",
    env.LOCALAPPDATA || win32.resolve(home, "AppData", "Local"),
  );
  const dataRoot = win32.resolve(localAppData, "Meetron");
  const dedicatedProfileDir = win32.resolve(
    env.MEETING_COPILOT_PROFILE_DIR || win32.resolve(dataRoot, "GPTParticipantChrome"),
  );
  return assertResolvedPlatformPaths({
    runtimeDir: win32.resolve(
      env.MEETING_COPILOT_RUNTIME_DIR || win32.resolve(dataRoot, "Runtime"),
    ),
    dedicatedProfileDir,
    legacyProfileDir: win32.resolve(localAppData, "MeetingCopilot", "ChatGPTVoiceChrome"),
    chromeApplications: chromeApplications({ home, env }),
    nativeMessagingManifestDirs: [win32.resolve(dataRoot, "NativeMessagingHosts")],
  });
}

function registryChromePaths(env = process.env) {
  const reg = systemExecutable("reg.exe", env);
  const keys = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
  ];
  const paths = [];
  for (const key of keys) {
    const result = spawnSync(reg, ["query", key, "/ve"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) continue;
    const match = result.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/m);
    if (match?.[1]) paths.push(match[1].trim());
  }
  return paths;
}

function chromeApplications({ home, env = process.env }) {
  if (env.MEETING_COPILOT_CHROME_PATH) return [env.MEETING_COPILOT_CHROME_PATH];
  const candidates = [
    ...registryChromePaths(env),
    env.ProgramFiles && win32.resolve(env.ProgramFiles, "Google/Chrome/Application/chrome.exe"),
    env["ProgramFiles(x86)"] &&
      win32.resolve(env["ProgramFiles(x86)"], "Google/Chrome/Application/chrome.exe"),
    env.LOCALAPPDATA &&
      win32.resolve(env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    win32.resolve(home, "AppData/Local/Google/Chrome/Application/chrome.exe"),
  ].filter(Boolean);
  return [...new Set(candidates.map((candidate) => win32.resolve(candidate)))];
}

function parseJsonList(stdout) {
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function listProcesses(env = process.env) {
  const script = [
    "Get-CimInstance Win32_Process",
    "Select-Object ProcessId,CommandLine",
    "ConvertTo-Json -Compress",
  ].join(" | ");
  const { stdout } = await execFileAsync(
    powershellExecutable(env),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  return parseJsonList(stdout)
    .map((entry) => ({
      pid: Number(entry.ProcessId),
      command: typeof entry.CommandLine === "string" ? entry.CommandLine : "",
    }))
    .filter(({ pid }) => Number.isInteger(pid) && pid > 0);
}

async function processCommand(pid, env = process.env) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`;
  try {
    const { stdout } = await execFileAsync(
      powershellExecutable(env),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
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
  process.kill(pid, signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
}

function terminateTree(pid, _signal = "SIGTERM", env = process.env) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const result = spawnSync(systemExecutable("taskkill.exe", env), ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 && processExists(pid)) {
    throw new Error(result.stderr.trim() || `Could not terminate process tree ${pid}`);
  }
}

function nativeCommand(command, args) {
  if (["npm", "npm.cmd"].includes(win32.basename(command).toLocaleLowerCase("en-US"))) {
    const npmCli = win32.resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    if (existsSync(npmCli)) return { command: process.execPath, args: [npmCli, ...args] };
  }
  return { command, args };
}

const processCapability = {
  run(command, args = [], options = {}) {
    const invocation = nativeCommand(command, args);
    return execFileAsync(invocation.command, invocation.args, { windowsHide: true, ...options });
  },
  runSync(command, args = [], options = {}) {
    const invocation = nativeCommand(command, args);
    return execFileSync(invocation.command, invocation.args, { windowsHide: true, ...options });
  },
  spawn(command, args = [], options = {}) {
    const invocation = nativeCommand(command, args);
    return spawn(invocation.command, invocation.args, { windowsHide: true, ...options });
  },
  spawnSync(command, args = [], options = {}) {
    const invocation = nativeCommand(command, args);
    return spawnSync(invocation.command, invocation.args, { windowsHide: true, ...options });
  },
  exists: processExists,
  command: processCommand,
  list: listProcesses,
  terminate,
  terminateTree,
  commandEnvironment({ env = process.env, nodePath = "" } = {}) {
    const paths = [nodePath ? dirname(nodePath) : "", env.PATH || ""].filter(Boolean);
    return { ...env, PATH: paths.join(delimiter) };
  },
};

function commandLineArgument(command, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.match(new RegExp(`(?:^|\\s)--${escapedName}=(?:"([^"]*)"|([^\\s]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? "";
}

async function profileProcesses(profileDir) {
  const expected = win32.normalize(profileDir).toLocaleLowerCase("en-US");
  return (await listProcesses()).filter(({ command }) => {
    const executable = command.match(/^\s*(?:"([^"]+)"|([^\s]+))/)?.[1] ||
      command.match(/^\s*(?:"([^"]+)"|([^\s]+))/)?.[2] || "";
    const configuredProfile = commandLineArgument(command, "user-data-dir");
    return win32.basename(executable).toLocaleLowerCase("en-US") === "chrome.exe" &&
      win32.normalize(configuredProfile).toLocaleLowerCase("en-US") === expected;
  });
}

function currentUserSid(env = process.env) {
  const result = spawnSync(
    powershellExecutable(env),
    [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0 || !/^S-\d-(?:\d+-)+\d+$/.test(result.stdout.trim())) {
    throw new Error("Could not resolve the current Windows user SID for ACL protection.");
  }
  return result.stdout.trim();
}

function applyAcl(path, directory, env = process.env) {
  const sid = currentUserSid(env);
  const permission = directory ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  const result = spawnSync(
    systemExecutable("icacls.exe", env),
    [path, "/inheritance:r", "/grant:r", permission],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Could not secure ${path}`);
  }
  return path;
}

function nativeBuildPath(repoRoot, executableName) {
  return win32.resolve(repoRoot, "native/windows/target/release", executableName);
}

function installLauncher({ repoRoot, runtimeDir, nodePath, scriptPath }) {
  const source = nativeBuildPath(repoRoot, "meetron-host.exe");
  if (!existsSync(source)) {
    throw new Error("meetron-host.exe has not been built. Run: npm run build:windows");
  }
  const launcherPath = win32.resolve(runtimeDir, "meetron-host.exe");
  const configPath = win32.resolve(runtimeDir, "meetron-host.conf");
  copyFileSync(source, launcherPath);
  writeFileSync(configPath, `${nodePath}\r\n${scriptPath}\r\n`, "utf8");
  applyAcl(launcherPath, false);
  applyAcl(configPath, false);
  return launcherPath;
}

export const windowsPlatformAdapter = definePlatformAdapter({
  id: "win32",
  label: "Windows",
  paths: { resolve: resolvePaths },
  chrome: {
    applications: chromeApplications,
    executable(applicationPath) {
      return win32.resolve(applicationPath);
    },
    launch(applicationPath, args = [], options = {}) {
      return spawn(applicationPath, args, { windowsHide: true, ...options });
    },
    profileProcesses,
  },
  process: processCapability,
  net: {
    async listenerPid(port, host = "127.0.0.1") {
      if (!Number.isInteger(port) || port < 1 || port > 65_535 || host !== "127.0.0.1") return null;
      const script = [
        `Get-NetTCPConnection -State Listen -LocalAddress '${host}' -LocalPort ${port}`,
        "Select-Object -First 1 -ExpandProperty OwningProcess",
      ].join(" | ");
      try {
        const { stdout } = await execFileAsync(
          powershellExecutable(),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          { encoding: "utf8", timeout: 5_000, windowsHide: true },
        );
        const pid = Number(stdout.trim());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
      } catch {
        return null;
      }
    },
  },
  fsSecurity: {
    secureDir(path) {
      mkdirSync(path, { recursive: true });
      return applyAcl(path, true);
    },
    secureFile(path) {
      return applyAcl(path, false);
    },
  },
  nativeHost: {
    launcherPath({ runtimeDir }) {
      return win32.resolve(runtimeDir, "meetron-host.exe");
    },
    installLauncher,
    installManifest({ manifest, directories, fileName }) {
      const directory = directories[0];
      mkdirSync(directory, { recursive: true });
      applyAcl(directory, true);
      const manifestPath = win32.resolve(directory, fileName);
      writeFileSync(manifestPath, manifest, "utf8");
      applyAcl(manifestPath, false);
      const result = spawnSync(
        systemExecutable("reg.exe"),
        ["add", NATIVE_HOST_REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"],
        { encoding: "utf8", windowsHide: true },
      );
      if (result.status !== 0) throw new Error(result.stderr.trim() || "Could not register Native Messaging Host.");
    },
    uninstallManifest({ directories, fileName }) {
      spawnSync(systemExecutable("reg.exe"), ["delete", NATIVE_HOST_REGISTRY_KEY, "/f"], {
        encoding: "utf8",
        windowsHide: true,
      });
      for (const directory of directories) rmSync(win32.resolve(directory, fileName), { force: true });
    },
  },
  audioControl: {
    controller: "mmdevice",
    executableCandidates({ repoRoot, env = process.env }) {
      if (env.MEETING_COPILOT_AUDIOCTL !== undefined) return [env.MEETING_COPILOT_AUDIOCTL];
      return [nativeBuildPath(repoRoot, "meetron-audioctl.exe")];
    },
    fallbackExecutableCandidates() {
      return [];
    },
  },
  shortcuts: { meetingMute: "Control+d" },
});

export const windowsPlatformInternals = Object.freeze({
  commandLineArgument,
  chromeApplications,
  resolvePaths,
});
