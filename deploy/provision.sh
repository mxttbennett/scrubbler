#!/usr/bin/env bash
# One-time provisioning for the scrobble-scrubber host (Ubuntu 22.04/24.04, x64 or ARM).
# Run as the deploy user with sudo: bash provision.sh
set -euo pipefail

APP_DIR=/opt/scrobble-scrubber
DEPLOY_USER="${SUDO_USER:-ubuntu}"

echo "== installing Node 22 =="
# NodeSource's setup script 403s from some cloud IPs, so install the official tarball directly.
if ! command -v node >/dev/null || [[ "$(node --version)" != v22* && "$(node --version)" != v2[3-9]* ]]; then
  case "$(uname -m)" in
    aarch64) NODE_ARCH=arm64 ;;
    x86_64)  NODE_ARCH=x64 ;;
    *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
  esac
  NODE_TARBALL=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ \
    | grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-${NODE_ARCH}\.tar\.xz" | head -1)
  curl -fsSLO "https://nodejs.org/dist/latest-v22.x/${NODE_TARBALL}"
  sudo tar -xJf "${NODE_TARBALL}" -C /usr/local --strip-components=1
  sudo ln -sf /usr/local/bin/node /usr/bin/node
  sudo ln -sf /usr/local/bin/npm /usr/bin/npm
  sudo ln -sf /usr/local/bin/npx /usr/bin/npx
  rm -f "${NODE_TARBALL}"
fi

echo "== build dependencies for better-sqlite3 (fallback if no prebuilt binary) =="
sudo apt-get update
sudo apt-get install -y build-essential python3 rsync

echo "== app directory =="
sudo mkdir -p "$APP_DIR/.data/backups"
sudo chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

echo "== systemd unit =="
sudo cp "$(dirname "$0")/scrobble-scrubber.service" /etc/systemd/system/scrobble-scrubber.service
sudo systemctl daemon-reload
sudo systemctl enable scrobble-scrubber

cat <<'NEXT'
== next steps ==
1. Create /opt/scrobble-scrubber/.env (copy .env.example) with LASTFM_USERNAME,
   LASTFM_PASSWORD, LASTFM_API_KEY and optionally DISCORD_WEBHOOK_URL. chmod 600.
2. LEAVE DRY_RUN=true. Start the service, read one sweep's report, and only then set
   DRY_RUN=false and restart. The first real run is the irreversible one.
3. Allow the deploy user to restart without a password (visudo):
     ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl stop scrobble-scrubber, /usr/bin/systemctl start scrobble-scrubber, /usr/bin/systemctl restart scrobble-scrubber
4. journalctl -u scrobble-scrubber -f
NEXT
