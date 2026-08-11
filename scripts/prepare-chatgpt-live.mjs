#!/usr/bin/env node

import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const options = {
  cdp: "http://127.0.0.1:9224",
  projectUrl: "",
};

function usage() {
  process.stdout.write(`Usage: node scripts/prepare-chatgpt-live.mjs [options]\n\nOptions:\n  --cdp URL           Chrome DevTools endpoint (default: ${options.cdp})\n  --project-url URL   ChatGPT Project landing URL\n  -h, --help          Show this help\n`);
}

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  switch (argument) {
    case "--cdp":
      options.cdp = args[++index] || "";
      break;
    case "--project-url":
      options.projectUrl = args[++index] || "";
      break;
    case "-h":
    case "--help":
      usage();
      process.exit(0);
      break;
    default:
      process.stderr.write(`Unknown argument: ${argument}\n`);
      usage();
      process.exit(2);
  }
}

if (!/^https:\/\/chatgpt\.com\/g\/g-p-[^/]+\/project(?:[/?#]|$)/.test(options.projectUrl)) {
  process.stderr.write("A ChatGPT Project landing URL is required with --project-url.\n");
  process.exit(2);
}

const browser = await chromium.connectOverCDP(options.cdp);
const contexts = browser.contexts();
if (contexts.length === 0) {
  throw new Error("Chrome did not expose a browser context.");
}

const context = contexts[0];
await context.grantPermissions(["microphone"], {
  origin: "https://chatgpt.com",
});

let page = context
  .pages()
  .find((candidate) => candidate.url().startsWith("https://chatgpt.com/"));

if (!page) {
  page = await context.newPage();
}

await page.goto(options.projectUrl, { waitUntil: "domcontentloaded" });
await page.bringToFront();
page.setDefaultTimeout(10_000);

const loginButton = page.getByRole("button", { name: /^(ログイン|Log in)$/i });
const loginHeading = page.getByText(/ログインまたは新規登録|Log in or sign up/i);
const profileButton = page.getByRole("button", {
  name: /プロファイルメニューを開く|profile menu/i,
});

if (!page.url().includes("/auth/")) {
  await Promise.race([
    loginButton.first().waitFor({ state: "visible", timeout: 15_000 }),
    loginHeading.first().waitFor({ state: "visible", timeout: 15_000 }),
    profileButton.first().waitFor({ state: "visible", timeout: 15_000 }),
  ]).catch(() => {});
}

const loginRequired =
  page.url().includes("/auth/") ||
  ((await loginButton.count()) > 0 && (await loginButton.first().isVisible())) ||
  ((await loginHeading.count()) > 0 && (await loginHeading.first().isVisible()));

if (loginRequired) {
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "login-required",
        url: page.url(),
        message: "Sign in to ChatGPT in this dedicated browser, then run the launcher again.",
      },
      null,
      2,
    )}\n`,
  );
  process.exit(10);
}

const newChat = page
  .getByRole("textbox", {
    name: /内の新しいチャット|new chat in|ChatGPT とチャットする/i,
  })
  .first();
await newChat.waitFor({ state: "visible", timeout: 20_000 });

const startVoice = page.getByRole("button", {
  name: /^(音声を開始する|Start voice)$/i,
});
await startVoice.waitFor({ state: "visible", timeout: 10_000 });
await startVoice.click();

const endVoice = page.getByRole("button", {
  name: /^(音声を終了する|End voice)$/i,
});
await endVoice.waitFor({ state: "visible", timeout: 30_000 });

const microphoneOn = page.getByRole("button", {
  name: /^(マイクをオフにする|Turn off microphone)$/i,
});

const result = {
  status: "voice-active",
  url: page.url(),
  projectUrl: options.projectUrl,
  newChatCreated: true,
  microphoneOn: await microphoneOn.isVisible(),
  title: await page.title(),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(0);
