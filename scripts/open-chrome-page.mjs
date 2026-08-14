#!/usr/bin/env node

import { chromium } from "playwright-core";

const args = process.argv.slice(2);
let cdp = "http://127.0.0.1:9223";
let targetUrl = "";

function usage() {
  process.stdout.write(`Usage: node scripts/open-chrome-page.mjs --url URL [--cdp URL]\n`);
}

for (let index = 0; index < args.length; index += 1) {
  switch (args[index]) {
    case "--cdp":
      cdp = args[++index] || "";
      break;
    case "--url":
      targetUrl = args[++index] || "";
      break;
    case "-h":
    case "--help":
      usage();
      process.exit(0);
      break;
    default:
      process.stderr.write(`Unknown argument: ${args[index]}\n`);
      usage();
      process.exit(2);
  }
}

let parsedUrl;
try {
  parsedUrl = new URL(targetUrl);
} catch {
  process.stderr.write("A valid URL is required with --url.\n");
  process.exit(2);
}
if (!new Set(["https:", "chrome:"]).has(parsedUrl.protocol)) {
  process.stderr.write("Only HTTPS and Chrome internal URLs are supported.\n");
  process.exit(2);
}

const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0];
if (!context) {
  throw new Error("Chrome did not expose a browser context.");
}
const page = await context.newPage();
await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
await page.bringToFront();
process.stdout.write(`${JSON.stringify({ opened: true, url: page.url() })}\n`);
