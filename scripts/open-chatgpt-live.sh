#!/usr/bin/env bash

set -eu

dry_run=0
restart_profile=0
project_url=''
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
environment_project_url="${MEETING_COPILOT_CHATGPT_PROJECT_URL:-}"
environment_cdp_port="${MEETING_COPILOT_CHATGPT_CDP_PORT:-}"

if [ -f "$repo_root/.meeting-copilot.env" ]; then
  # shellcheck disable=SC1091
  . "$repo_root/.meeting-copilot.env"
fi

if [ -n "$environment_project_url" ]; then
  MEETING_COPILOT_CHATGPT_PROJECT_URL="$environment_project_url"
fi
if [ -n "$environment_cdp_port" ]; then
  MEETING_COPILOT_CHATGPT_CDP_PORT="$environment_cdp_port"
fi

usage() {
  cat <<'EOF'
Usage: ./scripts/open-chatgpt-live.sh [options]

Opens a new voice chat in a ChatGPT Project using a dedicated Chrome profile.

Environment variables:
  MEETING_COPILOT_CHATGPT_PROJECT_URL   ChatGPT Project landing URL.
  MEETING_COPILOT_CHATGPT_PROFILE_DIR   Dedicated Chrome user data directory.
  MEETING_COPILOT_CHATGPT_CDP_PORT      Local automation port (default: 9224).
  MEETING_COPILOT_CHROME_PATH           Override the Google Chrome .app path.

Options:
  --project-url URL    Override the configured ChatGPT Project URL.
  --restart-profile   Restart the dedicated ChatGPT Chrome profile.
  --dry-run           Print the launch command without opening Chrome.
  -h, --help          Show this help.

The first run leaves the dedicated browser open for ChatGPT sign-in. Sign in
once, close or restart that profile, and run this command again.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-url)
      shift
      project_url="${1:-}"
      ;;
    --restart-profile)
      restart_profile=1
      ;;
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

if [ -z "$project_url" ]; then
  project_url="${MEETING_COPILOT_CHATGPT_PROJECT_URL:-}"
fi

case "$project_url" in
  https://chatgpt.com/g/g-p-*/project*) ;;
  *)
    printf 'Set MEETING_COPILOT_CHATGPT_PROJECT_URL to a ChatGPT Project landing URL.\n' >&2
    exit 2
    ;;
esac

find_chrome() {
  for app_path in \
    '/Applications/Google Chrome.app' \
    "$HOME/Applications/Google Chrome.app"; do
    if [ -d "$app_path" ]; then
      printf '%s\n' "$app_path"
      return 0
    fi
  done
  return 1
}

chrome_path="${MEETING_COPILOT_CHROME_PATH:-}"
if [ -z "$chrome_path" ]; then
  chrome_path="$(find_chrome || true)"
fi

if [ -z "$chrome_path" ] || [ ! -d "$chrome_path" ]; then
  printf 'Google Chrome was not found.\n' >&2
  exit 1
fi

chrome_binary="$chrome_path/Contents/MacOS/${chrome_path##*/}"
chrome_binary="${chrome_binary%.app}"
if [ ! -x "$chrome_binary" ]; then
  printf 'Chrome executable was not found at %s.\n' "$chrome_binary" >&2
  exit 1
fi

profile_dir="${MEETING_COPILOT_CHATGPT_PROFILE_DIR:-$HOME/Library/Application Support/MeetingCopilot/ChatGPTVoiceChrome}"
cdp_port="${MEETING_COPILOT_CHATGPT_CDP_PORT:-9224}"

if [ "$dry_run" -eq 1 ]; then
  printf '[DRY RUN] open -na %q --args --remote-debugging-address=127.0.0.1 --remote-debugging-port=%q --use-fake-ui-for-media-stream --user-data-dir=%q --no-first-run --new-window %q\n' \
    "$chrome_path" "$cdp_port" "$profile_dir" "$project_url"
  exit 0
fi

if [ ! -d "$repo_root/node_modules/playwright-core" ]; then
  printf 'playwright-core is required. Run: npm install\n' >&2
  exit 1
fi

mkdir -p "$profile_dir"

find_profile_pids() {
  ps -axo pid=,command= | awk -v profile="--user-data-dir=$profile_dir" '
    index($0, profile) && $0 ~ /Contents\/MacOS\// && $0 !~ /Helper/ { print $1 }
  '
}

profile_pids="$(find_profile_pids)"
if [ -n "$profile_pids" ]; then
  if [ "$restart_profile" -ne 1 ]; then
    printf 'The dedicated ChatGPT Chrome profile is already running.\n' >&2
    printf 'Close it or pass --restart-profile.\n' >&2
    exit 1
  fi

  printf '[INFO] Restarting dedicated ChatGPT Chrome profile.\n'
  for profile_pid in $profile_pids; do
    kill "$profile_pid" 2>/dev/null || true
  done

  attempts=0
  while [ -n "$(find_profile_pids)" ] && [ "$attempts" -lt 20 ]; do
    sleep 0.25
    attempts=$((attempts + 1))
  done
fi

open -na "$chrome_path" --args \
  --remote-debugging-address=127.0.0.1 \
  "--remote-debugging-port=$cdp_port" \
  --use-fake-ui-for-media-stream \
  "--user-data-dir=$profile_dir" \
  --no-first-run \
  --new-window \
  "$project_url"

attempts=0
while ! curl --silent --fail "http://127.0.0.1:$cdp_port/json/version" >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 40 ]; then
    printf 'Chrome automation endpoint did not start on port %s.\n' "$cdp_port" >&2
    exit 1
  fi
  sleep 0.25
done

set +e
node "$repo_root/scripts/prepare-chatgpt-live.mjs" \
  --cdp "http://127.0.0.1:$cdp_port" \
  --project-url "$project_url"
prepare_status=$?
set -e

if [ "$prepare_status" -eq 10 ]; then
  printf '\nSign in to ChatGPT in the dedicated browser, then rerun this command.\n'
  exit 10
fi

if [ "$prepare_status" -ne 0 ]; then
  exit "$prepare_status"
fi

printf '\nChatGPT Voice is active in a new Meeting Copilot chat.\n'
