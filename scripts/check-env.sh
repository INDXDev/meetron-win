#!/usr/bin/env bash

set -u

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: ./scripts/check-env.sh

Checks the local macOS, required applications, BlackHole drivers, and audio
devices needed by Meeting Copilot. Missing required dependencies produce a
non-zero exit status.
EOF
  exit 0
fi

if [ "$#" -ne 0 ]; then
  printf 'Unknown argument: %s\n' "$1" >&2
  printf 'Run with --help for usage.\n' >&2
  exit 2
fi

required_missing=0
warnings=0

ok() {
  printf '[OK]      %s\n' "$1"
}

missing() {
  printf '[MISSING] %s\n' "$1"
  required_missing=$((required_missing + 1))
}

warn() {
  printf '[WARN]    %s\n' "$1"
  warnings=$((warnings + 1))
}

info() {
  printf '[INFO]    %s\n' "$1"
}

find_app() {
  for app_path in "$@"; do
    if [ -d "$app_path" ]; then
      printf '%s\n' "$app_path"
      return 0
    fi
  done
  return 1
}

blackhole_installed() {
  channels="$1"
  driver_path="/Library/Audio/Plug-Ins/HAL/BlackHole${channels}ch.driver"

  if [ -d "$driver_path" ]; then
    return 0
  fi

  if command -v SwitchAudioSource >/dev/null 2>&1 && SwitchAudioSource -a 2>/dev/null | grep -F "BlackHole ${channels}ch" >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

clean_text() {
  [ -n "$1" ] && ! printf '%s' "$1" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1
}

printf 'Meeting Copilot environment check\n'
printf '%s\n' '================================='

if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
  macos_version="$(sw_vers -productVersion 2>/dev/null || printf 'unknown')"
  architecture="$(uname -m 2>/dev/null || printf 'unknown')"
  ok "macOS ${macos_version} (${architecture})"
else
  missing 'macOS is required.'
fi

if command -v brew >/dev/null 2>&1; then
  ok "Homebrew: $(command -v brew)"
else
  missing 'Homebrew was not found.'
  info 'Install it from https://brew.sh/ and run this check again.'
fi

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  ok "Node.js: $(node --version), npm: $(npm --version)"
else
  missing 'Node.js and npm were not found.'
  info 'Install them with: brew install node'
fi

if blackhole_installed 2; then
  ok 'BlackHole 2ch is installed.'
else
  missing 'BlackHole 2ch was not found.'
  info 'Next: brew install --cask blackhole-2ch'
fi

if blackhole_installed 16; then
  ok 'BlackHole 16ch is installed.'
else
  missing 'BlackHole 16ch was not found.'
  info 'Next: brew install --cask blackhole-16ch'
fi

if command -v SwitchAudioSource >/dev/null 2>&1; then
  ok "SwitchAudioSource: $(command -v SwitchAudioSource)"
else
  missing 'SwitchAudioSource was not found.'
  info 'Next: brew install switchaudio-osx'
fi

chatgpt_path="$(find_app '/Applications/ChatGPT.app' "$HOME/Applications/ChatGPT.app" || true)"
if [ -n "$chatgpt_path" ]; then
  info "Optional ChatGPT app: ${chatgpt_path}"
else
  info 'ChatGPT.app is not installed (optional; ChatGPT Web Voice is used).'
fi

chrome_path="$(find_app \
  '/Applications/Google Chrome.app' \
  "$HOME/Applications/Google Chrome.app" || true)"
if [ -n "$chrome_path" ]; then
  ok "Google Chrome: ${chrome_path}"
else
  missing 'Google Chrome was not found.'
fi

printf '\nAudio devices\n'
printf '%s\n' '-------------'
if command -v SwitchAudioSource >/dev/null 2>&1; then
  audio_devices="$(SwitchAudioSource -a 2>/dev/null || true)"
  current_input="$(SwitchAudioSource -c -t input 2>/dev/null || true)"
  current_output="$(SwitchAudioSource -c -t output 2>/dev/null || true)"
  if clean_text "$audio_devices"; then
    printf '%s\n' "$audio_devices" | sort -u | sed 's/^/  - /'
  fi
  clean_text "$current_input" && info "Default input: ${current_input}"
  clean_text "$current_output" && info "Default output: ${current_output}"
fi

if ! clean_text "${audio_devices:-}"; then
  if command -v system_profiler >/dev/null 2>&1; then
    audio_devices="$(system_profiler SPAudioDataType 2>/dev/null | sed -n 's/^        \([^:][^:]*\):$/  - \1/p')"
    if [ -n "$audio_devices" ]; then
      printf '%s\n' "$audio_devices"
    else
      warn 'No readable audio device names were returned by the available tools.'
    fi
  else
    warn 'Audio devices could not be listed.'
  fi
fi

printf '\nSummary\n'
printf '%s\n' '-------'
if [ "$required_missing" -eq 0 ]; then
  ok "Required dependencies are present (${warnings} warning(s))."
  info 'Next: follow docs/audio-routing.md.'
  exit 0
fi

printf '[MISSING] %s required dependency check(s) failed.\n' "$required_missing"
info 'Run ./scripts/install-audio-deps.sh --dry-run to preview audio dependency installation.'
exit 1
