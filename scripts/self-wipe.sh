#!/usr/bin/env bash
#
# Self-wipe: remove nanoclaw from ALL fleet nodes, then the orchestrator itself.
#
# Can be run:
#   1. From the dev machine:  ./scripts/self-wipe.sh
#   2. By the orchestrator:   bash scripts/self-wipe.sh
#
# Reads data/ssh-fleet.json for the list of provisioned nodes.
# Wipes agent-only nodes first, then the orchestrator (self) last.
#
# THIS IS IRREVERSIBLE. The claw eats itself.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FLEET_CONFIG="$PROJECT_DIR/data/ssh-fleet.json"

REMOTE_DIR="/home/pi/nanoclaw"
WORKSPACE_DIR="/home/pi/nanoclaw-workspace"
SERVICE_NAME="nanoclaw.service"

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

log()  { echo -e "${GREEN}[wipe]${NC} $*"; }
warn() { echo -e "${YELLOW}[wipe]${NC} $*"; }
err()  { echo -e "${RED}[wipe]${NC} $*"; }

# --- Read fleet nodes from ssh-fleet.json ---
discover_fleet_hosts() {
  if [[ ! -f "$FLEET_CONFIG" ]]; then
    warn "No fleet config at $FLEET_CONFIG"
    return
  fi

  # Extract user@host for each node (jq-free — works on minimal Pi installs)
  node -e "
    const cfg = JSON.parse(require('fs').readFileSync('$FLEET_CONFIG', 'utf-8'));
    for (const n of cfg.nodes || []) {
      console.log((n.user || 'pi') + '@' + n.host);
    }
  " 2>/dev/null || warn "Failed to parse fleet config"
}

# --- Wipe a remote node ---
wipe_remote() {
  local host="$1"
  log "Wiping ${host}..."

  if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${host}" true 2>/dev/null; then
    warn "Cannot reach ${host}, skipping"
    return
  fi

  ssh "${host}" bash -s "${REMOTE_DIR}" "${WORKSPACE_DIR}" "${SERVICE_NAME}" <<'WIPE_SCRIPT'
set -euo pipefail

REMOTE_DIR="$1"
WORKSPACE_DIR="$2"
SERVICE_NAME="$3"

echo "  Hostname: $(hostname)"

# Stop and disable service if it exists
if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  echo "  Stopping $SERVICE_NAME"
  systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
fi
if systemctl --user is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
  echo "  Disabling $SERVICE_NAME"
  systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
fi

UNIT_FILE="$HOME/.config/systemd/user/$SERVICE_NAME"
if [[ -f "$UNIT_FILE" ]]; then
  echo "  Removing service file"
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload 2>/dev/null || true
fi

# Kill any lingering node processes from nanoclaw
pkill -f "nanoclaw" 2>/dev/null || true

# Remove repo and workspace
if [[ -d "$REMOTE_DIR" ]]; then
  echo "  Removing $REMOTE_DIR"
  rm -rf "$REMOTE_DIR"
fi
if [[ -d "$WORKSPACE_DIR" ]]; then
  echo "  Removing $WORKSPACE_DIR"
  rm -rf "$WORKSPACE_DIR"
fi

echo "  Done"
WIPE_SCRIPT

  log "${host} wiped"
}

# --- Main ---

SELF_HOST=$(hostname 2>/dev/null || echo "unknown")
log "Starting fleet wipe from ${SELF_HOST}"

# Get all fleet hosts
FLEET_HOSTS=$(discover_fleet_hosts)

if [[ -z "$FLEET_HOSTS" ]]; then
  warn "No fleet hosts found, wiping local only"
fi

# Wipe remote (agent-only) nodes first, skip self
for host in $FLEET_HOSTS; do
  # Check if this host is us (the orchestrator)
  remote_hostname=$(ssh -o ConnectTimeout=5 -o BatchMode=yes "$host" hostname 2>/dev/null || echo "")
  if [[ "$remote_hostname" == "$SELF_HOST" ]]; then
    log "Skipping ${host} (that's us, will wipe last)"
    continue
  fi
  wipe_remote "$host"
done

# Now wipe ourselves
log "Wiping self (${SELF_HOST})..."

# Don't stop the service — we might BE the service. Instead:
# 1. Remove the unit file so systemd won't restart us
# 2. Disable so it's gone from boot
# 3. daemon-reload so systemd forgets about us
# 4. Then delete everything. The running process keeps its open fds
#    and finishes fine even after the files are gone.
UNIT_FILE="$HOME/.config/systemd/user/$SERVICE_NAME"
if [[ -f "$UNIT_FILE" ]]; then
  log "Removing service file (prevents restart)"
  systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload 2>/dev/null || true
fi

# Remove workspace
if [[ -d "$WORKSPACE_DIR" ]]; then
  log "Removing $WORKSPACE_DIR"
  rm -rf "$WORKSPACE_DIR"
fi

# Remove repo (this script is inside it — remove last)
# Works because bash reads the script into memory / keeps fd open.
if [[ -d "$REMOTE_DIR" ]]; then
  log "Removing $REMOTE_DIR (goodbye, cruel world)"
  rm -rf "$REMOTE_DIR"
fi

log "Fleet wipe complete. Nothing remains."
