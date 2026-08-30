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

export function loadEnvironment(path = resolve(repoRoot, ".meeting-copilot.env"), env = process.env) {
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
