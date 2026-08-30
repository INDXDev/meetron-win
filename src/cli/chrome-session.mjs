import { existsSync, mkdirSync } from "node:fs";
import { platform, delay } from "./cli-utils.mjs";

export function findChrome({ home, env, candidates }) {
  const applications = env.MEETING_COPILOT_CHROME_PATH
    ? [env.MEETING_COPILOT_CHROME_PATH]
    : candidates || platform.chrome.applications({ home, env });
  return applications.find((candidate) => existsSync(candidate)) || "";
}

export async function endpointOwner({ profileDir, port }) {
  const expectedPort = `--remote-debugging-port=${port}`;
  const candidates = (await platform.chrome.profileProcesses(profileDir)).filter(
    ({ command }) =>
      command.includes("--remote-debugging-address=127.0.0.1") &&
      command.includes(expectedPort),
  );
  const listenerPid = await platform.net.listenerPid(Number(port));
  const owner = candidates.find(({ pid }) => pid === listenerPid);
  if (!owner) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(3_000),
    });
    const version = response.ok ? await response.json() : null;
    return typeof version?.webSocketDebuggerUrl === "string" ? owner : null;
  } catch {
    return null;
  }
}

export async function stopProfile(profileDir, { force = false } = {}) {
  const processes = await platform.chrome.profileProcesses(profileDir);
  for (const { pid } of processes) {
    try {
      platform.process.terminate(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      // A process may exit between enumeration and termination.
    }
  }
  return processes.length;
}

export async function waitForProfileExit(profileDir, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await platform.chrome.profileProcesses(profileDir)).length) return true;
    await delay(250);
  }
  return false;
}

export async function stopProfileGracefully(profileDir) {
  const count = await stopProfile(profileDir);
  if (!count) return 0;
  if (!(await waitForProfileExit(profileDir))) await stopProfile(profileDir, { force: true });
  return count;
}

export function chromeLaunchArguments({ profileDir, port, url, automated = true }) {
  return [
    ...(automated ? [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--use-fake-ui-for-media-stream",
    ] : []),
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--new-window",
    url,
  ];
}

export async function ensureChrome({ chromePath, profileDir, port, url, restart = false }) {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  let processes = await platform.chrome.profileProcesses(profileDir);
  if (processes.length && restart) {
    process.stdout.write("[INFO] Restarting shared Meetron Chrome profile.\n");
    await stopProfileGracefully(profileDir);
    processes = [];
  }
  if (processes.length) {
    if (!(await endpointOwner({ profileDir, port }))) {
      throw new Error("The shared Chrome profile is running without its automation endpoint.\nClose it, then run the command again.");
    }
    process.stdout.write("[INFO] Reusing shared Meetron Chrome profile.\n");
  } else {
    const child = platform.chrome.launch(
      chromePath,
      chromeLaunchArguments({ profileDir, port, url }),
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await endpointOwner({ profileDir, port })) return;
    await delay(250);
  }
  throw new Error(`Chrome automation endpoint did not start on port ${port}.`);
}
