#!/usr/bin/env node

import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const options = {
  cdp: "http://127.0.0.1:9223",
  projectUrl: "",
  replaceTab: false,
  outputDevice: "BlackHole 16ch",
};

function usage() {
  process.stdout.write(`Usage: node scripts/prepare-chatgpt-live.mjs [options]\n\nOptions:\n  --cdp URL            Chrome DevTools endpoint (default: ${options.cdp})\n  --project-url URL    ChatGPT Project landing URL\n  --output-device NAME ChatGPT Voice output device (default: ${options.outputDevice})\n  --replace-tab        Close only existing ChatGPT tabs before starting Voice\n  -h, --help           Show this help\n`);
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
    case "--output-device":
      options.outputDevice = args[++index] || "";
      break;
    case "--replace-tab":
      options.replaceTab = true;
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

const existingChatgptPages = context
  .pages()
  .filter((candidate) => candidate.url().startsWith("https://chatgpt.com/"));

let routingProbe = existingChatgptPages[0];
let temporaryProbe = false;
if (!routingProbe) {
  routingProbe = await context.newPage();
  temporaryProbe = true;
  await routingProbe.goto(options.projectUrl, { waitUntil: "domcontentloaded" });
} else {
  await routingProbe.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
}

const outputDevice = await routingProbe.evaluate(async (targetName) => {
  const outputs = (await navigator.mediaDevices.enumerateDevices())
    .filter((device) => device.kind === "audiooutput");
  const normalizedTarget = targetName.trim().toLowerCase();
  const target = outputs.find((device) =>
    device.label.trim().toLowerCase().startsWith(normalizedTarget),
  );
  return target ? { deviceId: target.deviceId, label: target.label } : null;
}, options.outputDevice);

if (!outputDevice) {
  throw new Error(`ChatGPT Voice output device was not found: ${options.outputDevice}`);
}

await context.addInitScript(({ sinkId, label }) => {
  const state = {
    sinkId,
    label,
    contexts: new Set(),
    failures: [],
  };
  Object.defineProperty(globalThis, "__meetingCopilotAudioRouting", {
    configurable: true,
    value: state,
  });

  const recordFailure = (error) => {
    state.failures.push(error instanceof Error ? error.message : String(error));
  };
  const routeMediaElement = (element) => {
    if (typeof element.setSinkId !== "function" || element.sinkId === sinkId) return Promise.resolve();
    return element.setSinkId(sinkId).catch(recordFailure);
  };

  const NativeAudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (NativeAudioContext && typeof NativeAudioContext.prototype.setSinkId === "function") {
    function RoutedAudioContext(contextOptions = {}) {
      const audioContext = new NativeAudioContext({ ...contextOptions, sinkId });
      state.contexts.add(audioContext);
      return audioContext;
    }
    Object.setPrototypeOf(RoutedAudioContext, NativeAudioContext);
    RoutedAudioContext.prototype = NativeAudioContext.prototype;
    if (globalThis.AudioContext === NativeAudioContext) globalThis.AudioContext = RoutedAudioContext;
    if (globalThis.webkitAudioContext === NativeAudioContext) globalThis.webkitAudioContext = RoutedAudioContext;
  }

  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function routedPlay(...playArguments) {
    return routeMediaElement(this).then(() => nativePlay.apply(this, playArguments));
  };

  const routeAddedMedia = (node) => {
    if (node instanceof HTMLMediaElement) void routeMediaElement(node);
    if (node instanceof Element) {
      for (const element of node.querySelectorAll("audio, video")) void routeMediaElement(element);
    }
  };
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) routeAddedMedia(node);
    }
  }).observe(document, { childList: true, subtree: true });
}, { sinkId: outputDevice.deviceId, label: outputDevice.label });

if (temporaryProbe) {
  await routingProbe.close();
}

if (options.replaceTab) {
  await Promise.all(existingChatgptPages.map((candidate) => candidate.close()));
}

let page = options.replaceTab ? null : existingChatgptPages[0];

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

const audioOutput = await page.evaluate(async () => {
  const state = globalThis.__meetingCopilotAudioRouting;
  if (!state) return { routed: false, error: "Audio routing was not initialized." };
  const mediaElements = [...document.querySelectorAll("audio, video")];
  const activeContexts = [...state.contexts].filter((audioContext) => audioContext.state !== "closed");
  const results = await Promise.allSettled([
    ...activeContexts.map((audioContext) => audioContext.setSinkId(state.sinkId)),
    ...mediaElements.map((element) => element.setSinkId(state.sinkId)),
  ]);
  const failures = [
    ...state.failures,
    ...results.filter((result) => result.status === "rejected").map((result) => result.reason?.message || String(result.reason)),
  ];
  return {
    routed: failures.length === 0,
    device: state.label,
    audioContexts: activeContexts.length,
    closedAudioContexts: state.contexts.size - activeContexts.length,
    mediaElements: mediaElements.length,
    failures,
  };
});

if (!audioOutput.routed) {
  throw new Error(`ChatGPT Voice output could not be routed to ${outputDevice.label}: ${audioOutput.failures?.join(" / ") || audioOutput.error}`);
}

const result = {
  status: "voice-active",
  url: page.url(),
  projectUrl: options.projectUrl,
  newChatCreated: true,
  replacedTab: options.replaceTab,
  microphoneOn: await microphoneOn.isVisible(),
  audioOutput,
  title: await page.title(),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(0);
