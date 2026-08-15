#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profileDir = await mkdtemp(resolve(tmpdir(), "meeting-copilot-prepare-meet-"));

const port = await new Promise((resolvePort, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const allocated = server.address().port;
    server.close(() => resolvePort(allocated));
  });
});

const chrome = spawn(
  executablePath,
  [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--disable-background-networking",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let browser;
try {
  let endpointReady = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    endpointReady = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((response) => response.ok)
      .catch(() => false);
    if (endpointReady) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (!endpointReady) throw new Error("Chrome CDP endpoint did not start.");

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  await context.route("https://meet.google.com/**", (route) => {
    const cameraOn = new URL(route.request().url()).searchParams.has("camera-on");
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <input aria-label="Name">
        <button aria-label="Microphone: BlackHole 16ch">Microphone</button>
        <button aria-label="Speaker: BlackHole 2ch">Speaker</button>
        <button aria-label="Turn on microphone">Muted</button>
        ${
          cameraOn
            ? '<button aria-label="Turn off camera" onclick="this.setAttribute(\'aria-label\', \'Turn on camera\')">Camera</button>'
            : "<p>Camera device is unavailable</p>"
        }
      </body></html>`,
    });
  });

  async function prepare(url) {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/prepare-meet.mjs"),
        "--cdp",
        `http://127.0.0.1:${port}`,
        "--url",
        url,
      ],
      { cwd: repoRoot, timeout: 30_000 },
    );
    return JSON.parse(stdout);
  }

  const unavailableCamera = await prepare("https://meet.google.com/abc-defg-hij");
  const enabledCamera = await prepare("https://meet.google.com/abc-defg-hij?camera-on=1");
  if (
    unavailableCamera.cameraDisabled !== true ||
    unavailableCamera.cameraState !== "unavailable" ||
    enabledCamera.cameraDisabled !== true ||
    enabledCamera.cameraState !== "off"
  ) {
    throw new Error(
      `Meet camera handling failed: ${JSON.stringify({ unavailableCamera, enabledCamera })}`,
    );
  }
} finally {
  await browser?.close().catch(() => {});
  chrome.kill();
  if (chrome.exitCode === null) {
    await Promise.race([
      new Promise((resolveExit) => chrome.once("exit", resolveExit)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
    ]);
  }
  await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

process.stdout.write("Meet camera unavailable and camera-off states are handled.\n");
