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
const profileDir = await mkdtemp(resolve(tmpdir(), "meeting-copilot-unified-profile-"));

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
  if (!endpointReady) {
    throw new Error("Chrome CDP endpoint did not start.");
  }

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  await context.route("https://chatgpt.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <button aria-label="Open profile menu">Profile</button>
        <textarea aria-label="New chat in Meeting Copilot"></textarea>
        <button aria-label="Start voice" onclick="
          this.setAttribute('aria-label', 'End voice');
          document.querySelector('#microphone').hidden = false;
        ">Voice</button>
        <button id="microphone" aria-label="Turn off microphone" hidden>Mic</button>
      </body></html>`,
    }),
  );
  await context.route("https://meet.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Meet preserved</title>" }),
  );

  const meetPage = await context.newPage();
  await meetPage.goto("https://meet.google.com/abc-defg-hij");
  const oldChatgptPage = await context.newPage();
  await oldChatgptPage.goto("https://chatgpt.com/old-chat");

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/prepare-chatgpt-live.mjs"),
      "--cdp",
      `http://127.0.0.1:${port}`,
      "--project-url",
      "https://chatgpt.com/g/g-p-test/project",
      "--replace-tab",
    ],
    { cwd: repoRoot, timeout: 30_000 },
  );
  const result = JSON.parse(stdout);
  const pages = context.pages();
  const meetPreserved = pages.some((page) => page.url().startsWith("https://meet.google.com/"));
  const chatgptPages = pages.filter((page) => page.url().startsWith("https://chatgpt.com/"));

  if (
    result.status !== "voice-active" ||
    result.replacedTab !== true ||
    !oldChatgptPage.isClosed() ||
    !meetPreserved ||
    meetPage.isClosed() ||
    chatgptPages.length !== 1
  ) {
    throw new Error(`ChatGPT tab replacement did not preserve Meet: ${JSON.stringify({ result, meetPreserved, chatgptPages: chatgptPages.length })}`);
  }
} finally {
  await browser?.close().catch(() => {});
  chrome.kill();
  await rm(profileDir, { recursive: true, force: true });
}

process.stdout.write("Unified profile preserves Meet while replacing the ChatGPT Voice tab.\n");
