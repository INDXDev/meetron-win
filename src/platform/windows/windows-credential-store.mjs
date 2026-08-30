import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { MeetronError } from "../../core/errors.mjs";
import { defineCredentialStore } from "../credential-store-contract.mjs";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function targetName(namespace, name) {
  if (!NAME_PATTERN.test(namespace) || !NAME_PATTERN.test(name)) {
    throw new MeetronError(
      "INVALID_CREDENTIAL_NAME",
      "Credential namespace and name must use letters, numbers, dots, underscores, or hyphens",
    );
  }
  return `Meetron:${namespace}:${name}`;
}

function parseResponse(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new MeetronError("CREDENTIAL_STORE_FAILED", "Credential Manager returned invalid data");
  }
}

function runCredentialHelper(executable, command, target, input = "") {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [command, target], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => reject(new MeetronError(
      "CREDENTIAL_STORE_UNAVAILABLE",
      `Could not start Windows Credential Manager helper: ${error.message}`,
    )));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new MeetronError(
          "CREDENTIAL_STORE_FAILED",
          Buffer.concat(stderr).toString("utf8").trim() || `Credential helper stopped (${code})`,
        ));
        return;
      }
      resolveResult(parseResponse(Buffer.concat(stdout).toString("utf8")));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function createWindowsCredentialStore({
  repoRoot,
  namespace = "community",
  executable,
  invoke,
} = {}) {
  const helper = executable || (repoRoot &&
    resolve(repoRoot, "native/windows/target/release/meetron-credential.exe"));
  if (!helper && !invoke) {
    throw new MeetronError("INVALID_CREDENTIAL_STORE", "repoRoot or executable is required");
  }
  const call = invoke || ((command, target, input) =>
    runCredentialHelper(helper, command, target, input));
  return defineCredentialStore({
    id: "windows-credential-manager",
    async get(name) {
      const result = await call("get", targetName(namespace, name), "");
      return result.found === true ? result.secret : null;
    },
    async set(name, value) {
      if (typeof value !== "string") {
        throw new MeetronError("INVALID_CREDENTIAL_VALUE", "Credential value must be a string");
      }
      await call("set", targetName(namespace, name), value);
    },
    async delete(name) {
      const result = await call("delete", targetName(namespace, name), "");
      return result.deleted === true;
    },
  });
}

export const windowsCredentialStoreInternals = Object.freeze({ targetName });
