#!/usr/bin/env bash
# install.sh — install the sudo-confirm pi extension.
#
# Usage:
#   bash install.sh                  # extension only
#   bash install.sh --sudo           # + passwordless sudo for the current user
#   bash install.sh --sudo --configs # + example models.json / settings.json
#
# Existing pi config files are backed up, never silently overwritten.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

want_sudo=false
want_configs=false
for arg in "$@"; do
  case "$arg" in
    --sudo)    want_sudo=true ;;
    --configs) want_configs=true ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# 1. The extension -------------------------------------------------------------
mkdir -p "$AGENT_DIR/extensions"
cp "$DIR/sudo-confirm.ts" "$AGENT_DIR/extensions/sudo-confirm.ts"
echo "✔ extension  -> $AGENT_DIR/extensions/sudo-confirm.ts"

# 2. Optional example configs -------------------------------------------------
if [ "$want_configs" = true ]; then
  for f in models.json settings.json; do
    src="$DIR/$f.example"
    dst="$AGENT_DIR/$f"
    [ -f "$src" ] || continue
    if [ -f "$dst" ]; then
      cp "$dst" "$dst.bak"
      echo "  backed up existing $dst -> $dst.bak"
      read -r -p "  overwrite $dst with the example? [y/N] " reply
      [ "${reply:-n}" = "y" ] || { echo "  skipped $f"; continue; }
    fi
    cp "$src" "$dst"
    echo "✔ config   -> $dst  (edit baseUrl before use)"
  done
fi

# 3. Optional passwordless sudo ----------------------------------------------
if [ "$want_sudo" = true ]; then
  user="$(whoami)"
  echo
  echo "About to grant passwordless sudo to '$user' (ALL commands)."
  read -r -p "Continue? [y/N] " reply
  if [ "${reply:-n}" = "y" ]; then
    echo "$user ALL=(ALL) NOPASSWD: ALL" | sudo tee "/etc/sudoers.d/90-$user-nopass" >/dev/null
    sudo chmod 440 "/etc/sudoers.d/90-$user-nopass"
    sudo visudo -c
    echo "✔ sudo     -> /etc/sudoers.d/90-$user-nopass"
    echo "  Revert with: sudo rm /etc/sudoers.d/90-$user-nopass"
  else
    echo "  skipped sudo setup"
  fi
fi

echo
echo "Done. Restart pi (or run /reload) to load the extension."
echo "Test: ask pi to run 'sudo id' — it should ask for confirmation first."
