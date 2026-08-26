#!/usr/bin/env node

import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import {
  getChatgptWebUiState,
  sendMeetingScreenshotToChatgpt,
} from "../src/chatgpt/chatgpt-web.mjs";

const executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 640, height: 480 } });
  const meetingPage = await context.newPage();
  await meetingPage.setContent(`<!doctype html><html><body style="margin:0">
    <main style="width:100vw;height:100vh;background:#eef3f8;padding:24px">
      <h1>Advertising report</h1><p>Spend ¥1,240,000 / ROAS 412%</p>
    </main>
  </body></html>`);

  const chatgptPage = await context.newPage();
  await chatgptPage.setContent(`<!doctype html><html><body>
    <button aria-label="Voice settings">Voice settings</button>
    <input id="stale-image" type="file" accept="image/*">
    <input id="image" type="file" accept="image/*">
    <div id="composer" role="textbox" contenteditable="true"></div>
    <button data-testid="send-button" aria-label="Send prompt">Send</button>
    <script>
      const input = document.querySelector('#image');
      input.addEventListener('change', () => {
        const button = document.createElement('button');
        button.id = 'attachment';
        button.setAttribute('aria-label', 'Remove file: ' + input.files[0].name);
        document.body.append(button);
      });
      document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
        globalThis.__sent = {
          prompt: document.querySelector('#composer').textContent,
          filename: input.files[0]?.name || '',
          type: input.files[0]?.type || '',
          size: input.files[0]?.size || 0,
        };
        document.querySelector('#attachment')?.remove();
        document.querySelector('#composer').textContent = '';
      });
    </script>
  </body></html>`);

  assert.deepEqual(await getChatgptWebUiState(chatgptPage), {
    voiceActive: true,
    microphoneOn: false,
  });
  const result = await sendMeetingScreenshotToChatgpt({
    meetingPage,
    chatgptPage,
    contextLabel: "Zoom Web App",
  });
  const sent = await chatgptPage.evaluate(() => globalThis.__sent);
  assert.equal(result.sent, true);
  assert.deepEqual([result.width, result.height], [640, 480]);
  assert.ok(result.bytes > 1_000);
  assert.match(sent.prompt, /Zoom Web Appに表示されている画面/);
  assert.match(sent.filename, /^meetron-screen-\d+\.jpg$/);
  assert.equal(sent.type, "image/jpeg");
  assert.equal(sent.size, result.bytes);
  assert.deepEqual(Object.keys(result.stages), [
    "capture",
    "input-search",
    "upload",
    "preview-confirm",
    "prompt-fill",
    "send",
    "sent-confirm",
  ]);

  await chatgptPage.locator("#composer").fill("unsent draft");
  await assert.rejects(
    sendMeetingScreenshotToChatgpt({ meetingPage, chatgptPage }),
    (error) => error.code === "CHATGPT_DRAFT_PRESENT",
  );
  await chatgptPage.locator("#composer").fill("");

  const chooserPage = await context.newPage();
  await chooserPage.setContent(`<!doctype html><html><body>
    <button aria-label="Voice settings">Voice settings</button>
    <button id="attach" aria-label="Add photos and files">Attach</button>
    <input id="chooser-input" type="file" hidden>
    <div id="composer" role="textbox" contenteditable="true"></div>
    <button data-testid="send-button" aria-label="Send prompt">Send</button>
    <script>
      const input = document.querySelector('#chooser-input');
      document.querySelector('#attach').addEventListener('click', () => {
        globalThis.__attachmentButtonClicks = (globalThis.__attachmentButtonClicks || 0) + 1;
        input.click();
      });
      input.addEventListener('change', () => {
        setTimeout(() => {
          const button = document.createElement('button');
          button.id = 'generic-removal';
          button.setAttribute('aria-label', 'Remove attachment');
          document.body.append(button);
        }, 250);
      });
      document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
        globalThis.__chooserSent = input.files[0]?.name || '';
        document.querySelector('#composer').textContent = '';
        document.querySelector('#generic-removal')?.remove();
      });
    </script>
  </body></html>`);
  const chooserResult = await sendMeetingScreenshotToChatgpt({
    meetingPage,
    chatgptPage: chooserPage,
    timeouts: { fileChooser: 300, previewConfirm: 1_000, sentConfirm: 500, poll: 20 },
  });
  assert.equal(chooserResult.sent, true);
  assert.equal(await chooserPage.evaluate(() => globalThis.__attachmentButtonClicks), 1);
  assert.match(await chooserPage.evaluate(() => globalThis.__chooserSent), /^meetron-screen-/);
  assert.ok(chooserResult.stages["preview-confirm"] >= 200);

  const coveredSendPage = await context.newPage();
  await coveredSendPage.setContent(`<!doctype html><html><body>
    <button aria-label="Voice settings">Voice settings</button>
    <input id="image" type="file" accept="image/*">
    <div id="composer" role="textbox" contenteditable="true"></div>
    <button data-testid="send-button" aria-label="Send prompt">Send</button>
    <div style="position:fixed;inset:0;z-index:10"></div>
    <script>
      const input = document.querySelector('#image');
      input.addEventListener('change', () => {
        const button = document.createElement('button');
        button.setAttribute('aria-label', 'Remove attachment');
        document.body.append(button);
      });
      document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
        globalThis.__coveredSendClicked = true;
        document.querySelector('#composer').textContent = '';
      });
    </script>
  </body></html>`);
  const coveredSendResult = await sendMeetingScreenshotToChatgpt({
    meetingPage,
    chatgptPage: coveredSendPage,
    timeouts: { previewConfirm: 500, sendClick: 100, sentConfirm: 500, poll: 20 },
  });
  assert.equal(coveredSendResult.sent, true);
  assert.equal(await coveredSendPage.evaluate(() => globalThis.__coveredSendClicked), true);

  const uploadFailurePage = await context.newPage();
  await uploadFailurePage.setContent(`<!doctype html><html><body>
    <button aria-label="Voice settings">Voice settings</button>
    <input id="image" type="file">
    <div id="composer" role="textbox" contenteditable="true"></div>
    <button data-testid="send-button" aria-label="Send prompt">Send</button>
    <script>
      document.querySelector('#image').addEventListener('change', () => {
        const alert = document.createElement('div');
        alert.setAttribute('role', 'alert');
        alert.textContent = 'Upload failed';
        document.body.append(alert);
      });
    </script>
  </body></html>`);
  const uploadProgress = [];
  await assert.rejects(
    sendMeetingScreenshotToChatgpt({
      meetingPage,
      chatgptPage: uploadFailurePage,
      onProgress: (event) => uploadProgress.push(event),
      timeouts: { previewConfirm: 500, poll: 20 },
    }),
    (error) =>
      error.code === "CHATGPT_ATTACHMENT_UPLOAD_FAILED" &&
      error.details?.stage === "preview-confirm",
  );
  assert.ok(uploadProgress.some(
    (event) => event.event === "stage-failed" && event.code === "CHATGPT_ATTACHMENT_UPLOAD_FAILED",
  ));

  const sendFailurePage = await context.newPage();
  await sendFailurePage.setContent(`<!doctype html><html><body>
    <button aria-label="Voice settings">Voice settings</button>
    <input id="image" type="file" accept="image/*">
    <div id="composer" role="textbox" contenteditable="true"></div>
    <button data-testid="send-button" aria-label="Send prompt">Send</button>
    <script>
      document.querySelector('#image').addEventListener('change', () => {
        const button = document.createElement('button');
        button.setAttribute('aria-label', 'Delete');
        document.body.append(button);
      });
      document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
        const alert = document.createElement('div');
        alert.setAttribute('role', 'alert');
        alert.textContent = 'Message send failed';
        document.body.append(alert);
      });
    </script>
  </body></html>`);
  await assert.rejects(
    sendMeetingScreenshotToChatgpt({
      meetingPage,
      chatgptPage: sendFailurePage,
      timeouts: { previewConfirm: 500, sentConfirm: 500, poll: 20 },
    }),
    (error) => error.code === "CHATGPT_SEND_FAILED" && error.details?.stage === "sent-confirm",
  );

  const sendTimeoutPage = await context.newPage();
  await sendTimeoutPage.setContent(`<!doctype html><html><body>
    <button aria-label="Voice settings">Voice settings</button>
    <input id="image" type="file" accept="image/*">
    <div id="composer" role="textbox" contenteditable="true"></div>
    <button data-testid="send-button" aria-label="Send prompt">Send</button>
    <script>
      document.querySelector('#image').addEventListener('change', () => {
        const button = document.createElement('button');
        button.setAttribute('aria-label', 'Remove attachment');
        document.body.append(button);
      });
    </script>
  </body></html>`);
  await assert.rejects(
    sendMeetingScreenshotToChatgpt({
      meetingPage,
      chatgptPage: sendTimeoutPage,
      timeouts: { previewConfirm: 500, sentConfirm: 200, poll: 20 },
    }),
    (error) =>
      error.code === "CHATGPT_SEND_CONFIRM_TIMEOUT" &&
      error.details?.stage === "sent-confirm",
  );

  await chatgptPage.locator('[aria-label="Voice settings"]').evaluate((element) => element.remove());
  await chatgptPage.locator("body").evaluate((body) => {
    const button = document.createElement("button");
    button.setAttribute("aria-label", "End voice");
    body.prepend(button);
  });
  assert.equal((await getChatgptWebUiState(chatgptPage)).voiceActive, true);

  await chatgptPage.locator('[aria-label="End voice"]').evaluate((element) => element.remove());
  await assert.rejects(
    sendMeetingScreenshotToChatgpt({ meetingPage, chatgptPage }),
    (error) => error.code === "VOICE_NOT_ACTIVE",
  );
} finally {
  await browser.close();
}

process.stdout.write("ChatGPT Voice UI and in-memory screenshot sending passed.\n");
