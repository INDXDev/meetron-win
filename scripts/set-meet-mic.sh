#!/usr/bin/env bash

set -eu

wait_seconds="${MEETING_COPILOT_MIC_WAIT:-0}"
assume_before="${MEETING_COPILOT_MIC_ASSUME_BEFORE:-}"
state=''

usage() {
  cat <<'EOF'
Usage: ./scripts/set-meet-mic.sh [--wait SEC] [--assume-before STATE] STATE

Controls the microphone of the dedicated Google Meet participant.

OPTIONS:
  --wait SEC              Wait for admission before changing the mic.
  --assume-before STATE   Use muted or unmuted when Meet hides its mic control.

STATE:
  unmute   Turn the meeting microphone on.
  mute     Turn the meeting microphone off.
  toggle   Toggle the current microphone state.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --wait)
      shift
      wait_seconds="${1:-}"
      ;;
    --assume-before)
      shift
      assume_before="${1:-}"
      ;;
    unmute)
      state='unmuted'
      ;;
    mute)
      state='muted'
      ;;
    toggle)
      state='toggle'
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option or state: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

case "$wait_seconds" in
  ''|*[!0-9]*)
    printf '%s\n' '--wait must be a non-negative integer.' >&2
    exit 2
    ;;
esac

if [ -z "$state" ]; then
  printf 'A microphone state is required.\n' >&2
  usage >&2
  exit 2
fi

case "$assume_before" in
  ''|muted|unmuted) ;;
  *)
    printf '%s\n' '--assume-before must be muted or unmuted.' >&2
    exit 2
    ;;
esac

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
environment_cdp_port="${MEETING_COPILOT_CDP_PORT:-}"
if [ -f "$repo_root/.meeting-copilot.env" ]; then
  # shellcheck disable=SC1091
  . "$repo_root/.meeting-copilot.env"
fi
if [ -n "$environment_cdp_port" ]; then
  MEETING_COPILOT_CDP_PORT="$environment_cdp_port"
fi
cdp_port="${MEETING_COPILOT_CDP_PORT:-9223}"

args=(
  --cdp "http://127.0.0.1:$cdp_port"
  --state "$state"
  --wait "$wait_seconds"
)
if [ -n "$assume_before" ]; then
  args+=(--assume-before "$assume_before")
fi

node "$repo_root/scripts/set-meet-mic.mjs" "${args[@]}"
