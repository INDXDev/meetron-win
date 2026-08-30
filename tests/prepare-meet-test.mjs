#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectToChromeOverCDP } from "../scripts/playwright-cdp.mjs";
import { macosPlatformAdapter } from "../src/platform/macos/macos-platform-adapter.mjs";

const { run: execFileAsync, spawn } = macosPlatformAdapter.process;
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

  browser = await connectToChromeOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  await context.route("https://meet.google.com/**", (route) => {
    const url = new URL(route.request().url());
    const cameraOn = url.searchParams.has("camera-on");
    const cameraUnknown = url.searchParams.has("camera-unknown");
    const sameAccount = url.searchParams.has("same-account");
    const directSameAccount = url.searchParams.has("same-account-direct");
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <button aria-label="Microphone: Meetron: AI to Meeting">Microphone</button>
        <button aria-label="Speaker: Meetron: Meeting to AI">Speaker</button>
        <button aria-label="Turn on microphone">Muted</button>
        ${
          cameraOn
            ? '<button aria-label="Turn off camera" onclick="this.setAttribute(\'aria-label\', \'Turn on camera\')">Camera</button>'
            : cameraUnknown
              ? "<p>Camera status uses an unknown UI</p>"
              : "<p>Camera device is unavailable</p>"
        }
        ${
          directSameAccount
            ? `<p>Test User is already in this call</p>
              <button id="join-device" onclick="document.body.dataset.joinedOnThisDevice = 'true'; document.body.append(' Leave call ')">Join on this device too</button>
              <button id="companion" onclick="document.body.dataset.companionMode = 'true'">Use Companion mode</button>`
            : sameAccount
            ? `<p>Test User is already in this call</p>
              <button aria-label="Other ways to join" onclick="document.querySelector('#join-device').hidden = false; document.querySelector('#companion').hidden = false">Other ways</button>
              <button id="join-device" hidden onclick="document.body.dataset.joinedOnThisDevice = 'true'; document.body.append(' Leave call ')">Join on this device too</button>
              <button id="companion" hidden onclick="document.body.dataset.companionMode = 'true'">Use Companion mode</button>`
            : '<button aria-label="Join now" onclick="document.body.dataset.joinClicked = \'true\'; this.remove(); document.body.append(\' Leave call \')">Join</button>'
        }
      </body></html>`,
    });
  });

  async function prepare(url, { join = false, expectedExit = 0 } = {}) {
    const argumentsList = [
      resolve(repoRoot, "scripts/prepare-meet.mjs"),
      "--cdp",
      `http://127.0.0.1:${port}`,
      "--url",
      url,
      "--microphone-device",
      "Meetron: AI to Meeting",
      "--speaker-device",
      "Meetron: Meeting to AI",
    ];
    if (join) argumentsList.push("--join", "--join-delay", "0");
    try {
      const { stdout } = await execFileAsync(process.execPath, argumentsList, {
        cwd: repoRoot,
        timeout: 30_000,
      });
      if (expectedExit !== 0) throw new Error(`Expected exit ${expectedExit}, got 0.`);
      return JSON.parse(stdout);
    } catch (error) {
      if (error.code !== expectedExit) throw error;
      return JSON.parse(error.stdout);
    }
  }

  const unavailableCamera = await prepare("https://meet.google.com/abc-defg-hij");
  const enabledCamera = await prepare("https://meet.google.com/abc-defg-hij?camera-on=1");
  const unknownCamera = await prepare(
    "https://meet.google.com/abc-defg-hij?camera-unknown=1",
    { join: true, expectedExit: 16 },
  );
  const unknownCameraPage = context
    .pages()
    .find((page) => page.url().includes("camera-unknown=1"));
  const joinClicked = await unknownCameraPage?.evaluate(() => document.body.dataset.joinClicked);
  const sameAccount = await prepare(
    "https://meet.google.com/abc-defg-hij?same-account=1",
    { join: true },
  );
  const sameAccountPage = context
    .pages()
    .find((page) => page.url().includes("same-account=1"));
  const joinedOnThisDevice = await sameAccountPage?.evaluate(
    () => document.body.dataset.joinedOnThisDevice,
  );
  const companionMode = await sameAccountPage?.evaluate(
    () => document.body.dataset.companionMode,
  );
  const directSameAccount = await prepare(
    "https://meet.google.com/abc-defg-hij?same-account-direct=1",
    { join: true },
  );
  const directSameAccountPage = context
    .pages()
    .find((page) => page.url().includes("same-account-direct=1"));
  const joinedDirectly = await directSameAccountPage?.evaluate(
    () => document.body.dataset.joinedOnThisDevice,
  );
  const directCompanionMode = await directSameAccountPage?.evaluate(
    () => document.body.dataset.companionMode,
  );
  if (
    unavailableCamera.cameraDisabled !== true ||
    unavailableCamera.cameraState !== "unavailable" ||
    enabledCamera.cameraDisabled !== true ||
    enabledCamera.cameraState !== "off" ||
    unknownCamera.cameraDisabled !== false ||
    unknownCamera.cameraState !== "control-unavailable" ||
    unknownCamera.joinStatus !== "manual-camera-check-required" ||
    joinClicked ||
    sameAccount.connection !== "joined" ||
    sameAccount.joinStatus !== "joined" ||
    joinedOnThisDevice !== "true" ||
    companionMode ||
    directSameAccount.connection !== "joined" ||
    joinedDirectly !== "true" ||
    directCompanionMode
  ) {
    throw new Error(
      `Meet preparation handling failed: ${JSON.stringify({ unavailableCamera, enabledCamera, unknownCamera, joinClicked, sameAccount, joinedOnThisDevice, companionMode, directSameAccount, joinedDirectly, directCompanionMode })}`,
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

process.stdout.write("Meet camera and same-account admission states passed.\n");
