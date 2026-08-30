#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePaths = {
  "native-host.mjs": "scripts/native-host.mjs",
  "meeting-start-job.mjs": "scripts/meeting-start-job.mjs",
  "start-meetron.mjs": "src/cli/start-meetron.mjs",
  "session-launch.mjs": "scripts/session-launch.mjs",
  "open-gpt-participant.mjs": "src/cli/open-gpt-participant.mjs",
};
const sources = Object.fromEntries(await Promise.all(
  Object.entries(sourcePaths)
    .map(async ([name, path]) => [name, await readFile(resolve(repoRoot, path), "utf8")]),
));

assert.match(sources["native-host.mjs"], /meeting-start-job\.mjs"\),\s*"--url-stdin"/s);
assert.match(sources["native-host.mjs"], /child\.stdin\.end\(`\$\{meetingUrl\}\\n`\)/);
assert.match(sources["meeting-start-job.mjs"], /start-meetron\.mjs"\), "--url-stdin"/);
assert.match(sources["start-meetron.mjs"], /session-launch\.mjs"\), \["--url-stdin"\]/);
assert.match(sources["session-launch.mjs"], /"open-gpt-participant"/);
assert.match(sources["session-launch.mjs"], /\["--url-stdin", "--join"\]/);
assert.match(sources["session-launch.mjs"], /input: `\$\{meeting\.url\}\\n`/);
assert.match(sources["open-gpt-participant.mjs"], /--url-stdin/);

process.stdout.write("Meeting invitation secrets use standard-input transport.\n");
