#!/usr/bin/env bash

set -eu

remove_data=0
confirmed=0

usage() {
  cat <<'EOF'
Usage: ./scripts/uninstall.sh [--remove-data --yes]

Removes the Native Messaging Host registration. With --remove-data --yes, also
removes local settings, runtime files, and the shared dedicated Chrome profile.
The unpacked extension must still be removed manually from chrome://extensions.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --remove-data)
      remove_data=1
      ;;
    --yes)
      confirmed=1
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

if [ "$remove_data" -eq 1 ] && [ "$confirmed" -ne 1 ]; then
  printf '%s\n' '--remove-data requires --yes because dedicated login profiles will be deleted.' >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
"$repo_root/scripts/restore-audio.sh" >/dev/null 2>&1 || true
"$repo_root/scripts/install-control-ui.sh" --uninstall --quiet

if [ "$remove_data" -eq 1 ]; then
  shared_profile="${MEETING_COPILOT_PROFILE_DIR:-$HOME/Library/Application Support/MeetingCopilot/GPTParticipantChrome}"
  legacy_chatgpt_profile="$HOME/Library/Application Support/MeetingCopilot/ChatGPTVoiceChrome"
  rm -rf -- "$repo_root/.meeting-copilot-runtime" "$shared_profile" "$legacy_chatgpt_profile"
  rm -f -- "$repo_root/.meeting-copilot.env"
  printf 'Removed Meeting Copilot local data and dedicated Chrome profiles.\n'
fi

printf 'Remove Meeting Copilot Controls from regular and shared dedicated Chrome in chrome://extensions.\n'
