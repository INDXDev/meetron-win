#!/usr/bin/env bash

set -eu

dry_run=0

usage() {
  cat <<'EOF'
Usage: ./scripts/configure-audio.sh [--dry-run]

Sets the system input to BlackHole 2ch. The system output remains on the
current speaker or headphones, while ChatGPT Voice is routed separately.
The previous defaults are saved for restoration.
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

devices="$($switch_audio_source -a)"
for device in 'BlackHole 2ch' 'BlackHole 16ch'; do
  if ! printf '%s\n' "$devices" | grep -Fx "$device" >/dev/null; then
    printf 'Required audio device was not found: %s\n' "$device" >&2
    exit 1
  fi
done

if [ "$dry_run" -eq 1 ]; then
  printf '[DRY RUN] save the current input and output for restoration\n'
  printf '[DRY RUN] %s -t input -s %q\n' "$switch_audio_source" 'BlackHole 2ch'
  printf '[DRY RUN] keep the current system output unchanged\n'
  exit 0
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
runtime_dir="${MEETING_COPILOT_RUNTIME_DIR:-$repo_root/.meeting-copilot-runtime}"
state_path="$runtime_dir/audio-original.json"
current_input="$($switch_audio_source -c -t input)"
current_output="$($switch_audio_source -c -t output)"

mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"
if [ ! -f "$state_path" ]; then
  node -e '
    const fs = require("node:fs");
    const [path, input, output] = process.argv.slice(1);
    const temporary = `${path}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ input, output, outputChanged: false, savedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, path);
  ' "$state_path" "$current_input" "$current_output"
fi

"$switch_audio_source" -t input -s 'BlackHole 2ch' >/dev/null

resolved_input="$($switch_audio_source -c -t input)"
resolved_output="$($switch_audio_source -c -t output)"
if [ "$resolved_input" != 'BlackHole 2ch' ] || [ "$resolved_output" != "$current_output" ]; then
  printf 'The requested audio routing could not be verified.\n' >&2
  exit 1
fi

node -e '
  const output = process.argv[1];
  process.stdout.write(`${JSON.stringify({ input: "BlackHole 2ch", output, outputUnchanged: true, ready: true, restorable: true })}\n`);
' "$resolved_output"
