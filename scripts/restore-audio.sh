#!/usr/bin/env bash

set -eu

dry_run=0

usage() {
  cat <<'EOF'
Usage: ./scripts/restore-audio.sh [--dry-run]

Restores the macOS input and output saved by configure-audio.sh.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

switch_audio_source="${MEETING_COPILOT_SWITCH_AUDIO_SOURCE:-}"
if [ -z "$switch_audio_source" ]; then
  for candidate in /opt/homebrew/bin/SwitchAudioSource /usr/local/bin/SwitchAudioSource; do
    if [ -x "$candidate" ]; then
      switch_audio_source="$candidate"
      break
    fi
  done
fi

if [ -z "$switch_audio_source" ]; then
  printf 'SwitchAudioSource was not found. Run: brew install switchaudio-osx\n' >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
runtime_dir="${MEETING_COPILOT_RUNTIME_DIR:-$repo_root/.meeting-copilot-runtime}"
state_path="$runtime_dir/audio-original.json"
if [ ! -f "$state_path" ]; then
  printf '{"restored":false,"alreadyRestored":true}\n'
  exit 0
fi

original_input="$(node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).input;
  if (typeof value !== "string" || !value) process.exit(1);
  process.stdout.write(value);
' "$state_path")"
original_output="$(node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).output;
  if (typeof value !== "string" || !value) process.exit(1);
  process.stdout.write(value);
' "$state_path")"
should_restore_output="$(node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(value.outputChanged === false ? "0" : "1");
' "$state_path")"

devices="$($switch_audio_source -a)"
required_devices=("$original_input")
if [ "$should_restore_output" -eq 1 ]; then
  required_devices+=("$original_output")
fi
for device in "${required_devices[@]}"; do
  if ! printf '%s\n' "$devices" | grep -Fx "$device" >/dev/null; then
    printf 'The original audio device is no longer available: %s\n' "$device" >&2
    exit 1
  fi
done

if [ "$dry_run" -eq 1 ]; then
  printf '[DRY RUN] %s -t input -s %q\n' "$switch_audio_source" "$original_input"
  if [ "$should_restore_output" -eq 1 ]; then
    printf '[DRY RUN] %s -t output -s %q\n' "$switch_audio_source" "$original_output"
  else
    printf '[DRY RUN] keep the current system output unchanged\n'
  fi
  exit 0
fi

"$switch_audio_source" -t input -s "$original_input" >/dev/null
if [ "$should_restore_output" -eq 1 ]; then
  "$switch_audio_source" -t output -s "$original_output" >/dev/null
fi

resolved_input="$($switch_audio_source -c -t input)"
resolved_output="$($switch_audio_source -c -t output)"
if [ "$resolved_input" != "$original_input" ] || \
  { [ "$should_restore_output" -eq 1 ] && [ "$resolved_output" != "$original_output" ]; }; then
  printf 'The original audio routing could not be verified.\n' >&2
  exit 1
fi

rm -f "$state_path"
node -e '
  const [input, output, outputRestored] = process.argv.slice(1);
  process.stdout.write(`${JSON.stringify({ restored: true, input, output, outputRestored: outputRestored === "1" })}\n`);
' "$original_input" "$resolved_output" "$should_restore_output"
