#!/usr/bin/env bash

set -eu

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
failures=0
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/meeting-copilot-tests.XXXXXX")"
fake_chrome="$temp_dir/Google Chrome.app"
mkdir -p "$fake_chrome/Contents/MacOS"
touch "$fake_chrome/Contents/MacOS/Google Chrome"
chmod +x "$fake_chrome/Contents/MacOS/Google Chrome"
trap 'rm -rf "$temp_dir"' EXIT

pass() {
  printf '[PASS] %s\n' "$1"
}

fail() {
  printf '[FAIL] %s\n' "$1" >&2
  failures=$((failures + 1))
}

for script in "$repo_root"/scripts/*.sh; do
  if bash -n "$script"; then
    pass "bash syntax: ${script##*/}"
  else
    fail "bash syntax: ${script##*/}"
  fi
done

if "$repo_root/scripts/check-env.sh" --help >/dev/null; then
  pass 'check-env help'
else
  fail 'check-env help'
fi

if "$repo_root/scripts/configure-audio.sh" --help >/dev/null; then
  pass 'audio routing setup help'
else
  fail 'audio routing setup help'
fi

if "$repo_root/scripts/restore-audio.sh" --help >/dev/null; then
  pass 'audio routing restore help'
else
  fail 'audio routing restore help'
fi

if "$repo_root/scripts/uninstall.sh" --help >/dev/null; then
  pass 'uninstaller help'
else
  fail 'uninstaller help'
fi

if "$repo_root/scripts/install-audio-deps.sh" --dry-run --yes --accept-blackhole-license >/dev/null; then
  pass 'audio installer dry run'
else
  fail 'audio installer dry run'
fi

if node "$repo_root/scripts/prepare-meet.mjs" --help >/dev/null; then
  pass 'Meet preparation help'
else
  fail 'Meet preparation help'
fi

if node "$repo_root/scripts/prepare-chatgpt-live.mjs" --help >/dev/null; then
  pass 'ChatGPT Voice preparation help'
else
  fail 'ChatGPT Voice preparation help'
fi

if node "$repo_root/scripts/open-chrome-page.mjs" --help >/dev/null; then
  pass 'shared Chrome page opener help'
else
  fail 'shared Chrome page opener help'
fi

if node "$repo_root/scripts/set-meet-mic.mjs" --help >/dev/null; then
  pass 'Meet microphone control help'
else
  fail 'Meet microphone control help'
fi

if "$repo_root/scripts/set-meet-mic.sh" --help >/dev/null; then
  pass 'Meet microphone wrapper help'
else
  fail 'Meet microphone wrapper help'
fi

if node "$repo_root/scripts/set-meet-mic.mjs" \
  --state unmuted --assume-before invalid >/dev/null 2>&1; then
  fail 'Meet microphone rejects invalid assumed state'
else
  pass 'Meet microphone rejects invalid assumed state'
fi

if "$repo_root/scripts/install-control-ui.sh" --help >/dev/null; then
  pass 'control UI installer help'
else
  fail 'control UI installer help'
fi

node_binary="$(command -v node)"
if env -i HOME="$HOME" PATH=/usr/bin:/bin \
  MEETING_COPILOT_NODE_PATH="$node_binary" \
  "$repo_root/scripts/native-host.sh" --help >/dev/null; then
  pass 'Native Host starts with Chrome-style PATH'
else
  fail 'Native Host Chrome PATH compatibility'
fi

for javascript in "$repo_root"/extension/*.js "$repo_root"/scripts/*.mjs "$repo_root"/tests/*.mjs; do
  if node --check "$javascript"; then
    pass "JavaScript syntax: ${javascript##*/}"
  else
    fail "JavaScript syntax: ${javascript##*/}"
  fi
done

if node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (manifest.manifest_version !== 3) process.exit(1);
  if (manifest.action?.default_popup !== "popup.html") process.exit(1);
  const key = Buffer.from(manifest.key, "base64");
  const hex = crypto.createHash("sha256").update(key).digest().subarray(0, 16).toString("hex");
  const id = [...hex].map((value) => String.fromCharCode(97 + Number.parseInt(value, 16))).join("");
  if (id !== "jlikakgdldiihhflkobhnpfegjlcakdd") process.exit(1);
' "$repo_root/extension/manifest.json"; then
  pass 'extension manifest and stable ID'
else
  fail 'extension manifest and stable ID'
fi

if node "$repo_root/tests/native-host-test.mjs" >/dev/null; then
  pass 'Native Host protocol and setup validation'
else
  fail 'Native Host protocol ping'
fi

if node "$repo_root/tests/service-worker-test.mjs" >/dev/null; then
  pass 'service worker sender authorization'
else
  fail 'service worker sender authorization'
fi

if [ "${MEETING_COPILOT_SKIP_BROWSER_TEST:-0}" = "1" ]; then
  pass 'extension panel and popup UI browser test (skipped by environment)'
elif [ -x '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ]; then
  if node "$repo_root/tests/extension-ui-test.mjs" >/dev/null; then
    pass 'extension panel and popup UI browser test'
  else
    fail 'extension UI browser test'
  fi
  if node "$repo_root/tests/unified-profile-test.mjs" >/dev/null; then
    pass 'unified profile preserves Meet during Voice restart'
  else
    fail 'unified profile Voice restart isolation'
  fi
else
  pass 'extension panel and popup UI browser test (skipped: Chrome not installed)'
fi

native_manifest_output="$(MEETING_COPILOT_PROFILE_DIR="$temp_dir/dedicated-profile" \
  "$repo_root/scripts/install-control-ui.sh" --dry-run)"
if printf '%s\n' "$native_manifest_output" | grep -F -- 'chrome-extension://jlikakgdldiihhflkobhnpfegjlcakdd/' >/dev/null &&
  printf '%s\n' "$native_manifest_output" | grep -F -- 'com.meeting_copilot.host' >/dev/null &&
  printf '%s\n' "$native_manifest_output" | grep -F -- "$temp_dir/dedicated-profile/NativeMessagingHosts" >/dev/null; then
  pass 'Native Host installer dry run'
else
  fail 'Native Host installer dry run'
fi

launcher_output="$(MEETING_COPILOT_CHROME_PATH="$fake_chrome" \
  MEETING_COPILOT_PROFILE_DIR="$temp_dir/profile" \
  "$repo_root/scripts/open-gpt-participant.sh" --dry-run 'https://meet.google.com/abc-defg-hij')"
if printf '%s\n' "$launcher_output" | grep -F -- '--user-data-dir=' >/dev/null; then
  pass 'Meet launcher dry run'
else
  fail 'Meet launcher dry run'
fi

auto_launcher_output="$(MEETING_COPILOT_CHROME_PATH="$fake_chrome" \
  MEETING_COPILOT_PROFILE_DIR="$temp_dir/profile" \
  "$repo_root/scripts/open-gpt-participant.sh" --auto-prepare --restart-profile --dry-run \
  'https://meet.google.com/abc-defg-hij')"
if printf '%s\n' "$auto_launcher_output" | grep -F -- '--remote-debugging-address=127.0.0.1' >/dev/null &&
  printf '%s\n' "$auto_launcher_output" | grep -F -- '--use-fake-ui-for-media-stream' >/dev/null; then
  pass 'automated Meet launcher dry run'
else
  fail 'automated Meet launcher dry run'
fi

join_launcher_output="$(MEETING_COPILOT_CHROME_PATH="$fake_chrome" \
  MEETING_COPILOT_PROFILE_DIR="$temp_dir/profile" \
  "$repo_root/scripts/open-gpt-participant.sh" --join --join-delay 7 --restart-profile --dry-run \
  'https://meet.google.com/abc-defg-hij')"
if printf '%s\n' "$join_launcher_output" | grep -F -- 'wait 7 seconds' >/dev/null; then
  pass 'automated Meet admission dry run'
else
  fail 'automated Meet admission dry run'
fi

default_join_output="$(MEETING_COPILOT_CHROME_PATH="$fake_chrome" \
  MEETING_COPILOT_PROFILE_DIR="$temp_dir/profile" \
  "$repo_root/scripts/open-gpt-participant.sh" --join --restart-profile --dry-run \
  'https://meet.google.com/abc-defg-hij')"
if printf '%s\n' "$default_join_output" | grep -F -- 'wait 2 seconds' >/dev/null; then
  pass 'short default Meet admission delay'
else
  fail 'short default Meet admission delay'
fi

chatgpt_launcher_output="$(MEETING_COPILOT_CHROME_PATH="$fake_chrome" \
  MEETING_COPILOT_PROFILE_DIR="$temp_dir/profile" \
  MEETING_COPILOT_CDP_PORT=9223 \
  MEETING_COPILOT_CHATGPT_PROJECT_URL='https://chatgpt.com/g/g-p-test/project' \
  "$repo_root/scripts/open-chatgpt-live.sh" --restart-profile --dry-run)"
if printf '%s\n' "$chatgpt_launcher_output" | grep -F -- '--remote-debugging-port=9223' >/dev/null &&
  printf '%s\n' "$chatgpt_launcher_output" | grep -F -- "--user-data-dir=$temp_dir/profile" >/dev/null &&
  printf '%s\n' "$chatgpt_launcher_output" | grep -F -- 'https://chatgpt.com/g/g-p-test/project' >/dev/null; then
  pass 'ChatGPT Voice launcher dry run'
else
  fail 'ChatGPT Voice launcher dry run'
fi

if MEETING_COPILOT_CHROME_PATH="$fake_chrome" \
  "$repo_root/scripts/open-gpt-participant.sh" --dry-run 'http://example.com/not-a-meeting' >/dev/null 2>&1; then
  fail 'launcher rejects unsupported URLs'
else
  pass 'launcher rejects unsupported URLs'
fi

if [ "$failures" -ne 0 ]; then
  printf '%s test(s) failed.\n' "$failures" >&2
  exit 1
fi

printf 'All script tests passed.\n'
