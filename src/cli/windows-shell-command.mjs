#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PROTOCOL_VERSION } from "../core/protocol.mjs";
import { cliError, platform, repoRoot, runMain } from "./cli-utils.mjs";

const EXPECTED_ORIGIN = "chrome-extension://jlikakgdldiihhflkobhnpfegjlcakdd/";
const MAX_MESSAGE_BYTES = 1024 * 1024;

export function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_MESSAGE_BYTES) throw cliError("Windows shell request is too large");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function decodeNativeMessage(buffer) {
  if (buffer.length < 4) throw cliError("Native Host returned an incomplete response");
  const length = buffer.readUInt32LE(0);
  if (length > MAX_MESSAGE_BYTES || buffer.length !== length + 4) {
    throw cliError("Native Host returned an invalid response frame");
  }
  return JSON.parse(buffer.subarray(4).toString("utf8"));
}

export function invokeNativeHost(request, {
  nodePath = process.execPath,
  hostPath = resolve(repoRoot, "scripts/native-host.mjs"),
  env = process.env,
} = {}) {
  return new Promise((resolveResult, reject) => {
    const child = platform.process.spawn(nodePath, [hostPath, EXPECTED_ORIGIN], {
      cwd: repoRoot,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(cliError(
          Buffer.concat(stderr).toString("utf8").trim() || `Native Host stopped (${code})`,
          1,
        ));
        return;
      }
      try {
        resolveResult(decodeNativeMessage(Buffer.concat(stdout)));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(encodeNativeMessage(request));
  });
}

runMain(async () => {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Usage: node src/cli/windows-shell-command.mjs --request-stdin\n" +
      "Reads one protocol request as JSON from stdin and prints one response as JSON.\n",
    );
    return;
  }
  if (process.argv[2] !== "--request-stdin") {
    throw cliError("The Windows shell command requires --request-stdin");
  }
  let request;
  try {
    request = JSON.parse(await new Promise((resolveInput, reject) => {
      const chunks = [];
      process.stdin.on("data", (chunk) => chunks.push(chunk));
      process.stdin.on("end", () => resolveInput(Buffer.concat(chunks).toString("utf8")));
      process.stdin.on("error", reject);
    }));
  } catch {
    throw cliError("Windows shell request stdin must be valid JSON");
  }
  const response = await invokeNativeHost({
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId || randomUUID(),
    type: request.type,
    payload: request.payload || {},
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
});
