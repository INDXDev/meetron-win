#!/usr/bin/env bash

set -eu

dry_run=0
assume_yes=0
license_acknowledged=0

usage() {
  cat <<'EOF'
Usage: ./scripts/install-audio-deps.sh [options]

Installs BlackHole 2ch, BlackHole 16ch, and switchaudio-osx with Homebrew.

Options:
  --dry-run                       Print commands without installing anything.
  --yes                           Skip the interactive confirmation.
  --accept-blackhole-license      Acknowledge the displayed BlackHole notice.
  -h, --help                      Show this help.

For unattended installation, pass both --yes and --accept-blackhole-license.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      ;;
    --yes)
      assume_yes=1
      ;;
    --accept-blackhole-license)
      license_acknowledged=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$(uname -s 2>/dev/null || true)" != "Darwin" ]; then
  printf 'Error: this installer supports macOS only.\n' >&2
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  printf 'Error: Homebrew was not found. Install it from https://brew.sh/.\n' >&2
  exit 1
fi

cat <<'EOF'
BlackHole notice
----------------
BlackHole is an external dependency and is not redistributed by this project.
Its repository is GPLv3, and its official README says a license is required for
non-GPLv3 projects. Review the upstream terms before redistribution or
commercial use:

  https://github.com/ExistentialAudio/BlackHole
  https://github.com/ExistentialAudio/BlackHole/blob/master/LICENSE
EOF

if [ "$dry_run" -eq 0 ] && [ "$license_acknowledged" -eq 0 ]; then
  if [ -t 0 ]; then
    printf '\nContinue with Homebrew installation? [y/N] '
    read -r answer
    case "$answer" in
      y|Y|yes|YES)
        license_acknowledged=1
        ;;
      *)
        printf 'Installation cancelled.\n'
        exit 1
        ;;
    esac
  else
    printf '\nError: non-interactive use requires --accept-blackhole-license.\n' >&2
    exit 1
  fi
fi

if [ "$dry_run" -eq 0 ] && [ "$assume_yes" -eq 0 ] && [ ! -t 0 ]; then
  printf 'Error: non-interactive use requires --yes.\n' >&2
  exit 1
fi

run_command() {
  if [ "$dry_run" -eq 1 ]; then
    printf '[DRY RUN]'
    for argument in "$@"; do
      printf ' %q' "$argument"
    done
    printf '\n'
  else
    "$@"
  fi
}

install_blackhole() {
  channels="$1"
  cask="blackhole-${channels}ch"
  driver="/Library/Audio/Plug-Ins/HAL/BlackHole${channels}ch.driver"

  if [ -d "$driver" ]; then
    printf '[SKIP] %s driver is already installed.\n' "$cask"
  elif brew list --cask "$cask" >/dev/null 2>&1; then
    printf '[INFO] %s has Homebrew metadata but no loaded driver; reinstalling.\n' "$cask"
    run_command brew reinstall --cask "$cask"
  else
    run_command brew install --cask "$cask"
  fi
}

install_formula() {
  formula="$1"
  if brew list --formula "$formula" >/dev/null 2>&1; then
    printf '[SKIP] %s is already installed.\n' "$formula"
  else
    run_command brew install "$formula"
  fi
}

printf '\nInstalling audio dependencies\n'
install_blackhole 2
install_blackhole 16
install_formula switchaudio-osx

cat <<'EOF'

Next steps
----------
1. Restart macOS so the audio drivers are loaded.
2. Run ./scripts/check-env.sh.
3. Follow docs/audio-routing.md.

The installer does not create a Multi-Output Device or change the current
system input/output devices.
EOF
