#!/usr/bin/env bash
#
# Deploy nanoclaw to a Pi and set up as a systemd service.
# Run from the dev machine: ./scripts/setup-service.sh [host]
#
# Default host: 140 (moodymoose, the orchestrator)
#
set -euo pipefail

HOST="${1:-140}"
REPO_URL="https://github.com/kortexa-ai/nanoclaw.git"
REMOTE_DIR="/home/pi/nanoclaw"
BRANCH="${2:-main}"
NODE_BIN="/home/pi/.nvm/versions/node/v25.0.0/bin"

echo "==> Deploying nanoclaw to ${HOST} (branch: ${BRANCH})"

ssh "${HOST}" bash -s "${REPO_URL}" "${REMOTE_DIR}" "${BRANCH}" "${NODE_BIN}" <<'REMOTE_SCRIPT'
set -euo pipefail

REPO_URL="$1"
REMOTE_DIR="$2"
BRANCH="$3"
NODE_BIN="$4"
export PATH="${NODE_BIN}:${PATH}"

# --- Clone or pull ---
if [ -d "${REMOTE_DIR}/.git" ]; then
  echo "==> Updating existing repo"
  cd "${REMOTE_DIR}"
  git fetch origin
  git reset --hard HEAD
  git checkout "${BRANCH}"
  git reset --hard "origin/${BRANCH}"
else
  echo "==> Cloning repo"
  git clone --branch "${BRANCH}" "${REPO_URL}" "${REMOTE_DIR}"
  cd "${REMOTE_DIR}"
fi

# --- Install + build ---
echo "==> npm install"
npm install --production=false 2>&1 | tail -3

echo "==> npm run build"
npm run build 2>&1 | tail -5

# --- Create directories ---
mkdir -p "${REMOTE_DIR}/logs"
mkdir -p "${REMOTE_DIR}/store"
mkdir -p "${REMOTE_DIR}/groups/main/logs"
mkdir -p "${REMOTE_DIR}/data"

# --- Systemd unit ---
UNIT_FILE="/home/pi/.config/systemd/user/nanoclaw.service"
mkdir -p "$(dirname "${UNIT_FILE}")"

cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=NanoClaw Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REMOTE_DIR}
ExecStart=${NODE_BIN}/node ${REMOTE_DIR}/dist/index.js
Restart=always
RestartSec=5
Environment=HOME=/home/pi
Environment=PATH=${NODE_BIN}:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production

# Logging goes to journald + file
StandardOutput=append:${REMOTE_DIR}/logs/nanoclaw.log
StandardError=append:${REMOTE_DIR}/logs/nanoclaw.error.log

[Install]
WantedBy=default.target
EOF

echo "==> Enabling systemd user service"
systemctl --user daemon-reload
systemctl --user enable nanoclaw.service

# --- Enable lingering so user services run without login ---
if ! loginctl show-user pi -p Linger 2>/dev/null | grep -q "yes"; then
  echo "==> Enabling lingering for pi user"
  sudo loginctl enable-linger pi
fi

# --- Start (or restart if already running) ---
echo "==> Starting nanoclaw"
systemctl --user restart nanoclaw.service
sleep 2

if systemctl --user is-active --quiet nanoclaw.service; then
  echo ""
  echo "  nanoclaw is running on $(hostname)"
  echo "  MQTT broker: port 1883"
  echo ""
  echo "  Commands:"
  echo "    systemctl --user status nanoclaw"
  echo "    journalctl --user -u nanoclaw -f"
  echo "    systemctl --user restart nanoclaw"
  echo ""
else
  echo "ERROR: nanoclaw failed to start"
  systemctl --user status nanoclaw.service --no-pager
  exit 1
fi
REMOTE_SCRIPT

echo "==> Done. nanoclaw deployed to ${HOST}"
