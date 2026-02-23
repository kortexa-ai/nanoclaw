#!/usr/bin/env bash
#
# Migrate the NanoClaw orchestrator from one Pi to another.
# Run from the dev machine: ./scripts/migrate-orchestrator.sh <from-host> <to-host>
#
# Prerequisites:
#   - Both hosts reachable via SSH aliases (e.g., 140, 144)
#   - Destination has nanoclaw deployed (run setup-service.sh first)
#   - Pis can SSH to each other via id_pi_cluster key
#
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <from-host> <to-host>"
  echo "Example: $0 140 144"
  exit 1
fi

FROM="$1"
TO="$2"
REMOTE_DIR="/home/pi/nanoclaw"

echo "==> Migrating orchestrator: ${FROM} → ${TO}"

# --- Pre-flight checks ---
echo "==> Pre-flight: verifying SSH connectivity"
ssh -o ConnectTimeout=5 "${FROM}" true || { echo "ERROR: Cannot reach ${FROM}"; exit 1; }
ssh -o ConnectTimeout=5 "${TO}" true || { echo "ERROR: Cannot reach ${TO}"; exit 1; }

echo "==> Pre-flight: verifying repo exists on destination"
ssh "${TO}" "test -d ${REMOTE_DIR}/dist" || {
  echo "ERROR: ${REMOTE_DIR}/dist not found on ${TO}"
  echo "Run ./scripts/setup-service.sh ${TO} first"
  exit 1
}

# --- Stop orchestrator on source ---
echo "==> Stopping nanoclaw on ${FROM}"
ssh "${FROM}" "systemctl --user stop nanoclaw.service" || true
sleep 2

# Verify it's actually stopped
if ssh "${FROM}" "systemctl --user is-active --quiet nanoclaw.service" 2>/dev/null; then
  echo "ERROR: nanoclaw still running on ${FROM}, aborting"
  exit 1
fi
echo "    Stopped."

# --- Stop destination (in case it was running as agent-only) ---
echo "==> Stopping nanoclaw on ${TO} (if running)"
ssh "${TO}" "systemctl --user stop nanoclaw.service" || true
sleep 1

# --- Rsync state from source to destination ---
# Uses dev machine as relay (Pis may not have direct rsync)
echo "==> Syncing state: ${FROM} → ${TO}"

TMPDIR=$(mktemp -d)
trap "rm -rf ${TMPDIR}" EXIT

# Pull from source
echo "    Pulling from ${FROM}..."
rsync -az --relative "${FROM}:${REMOTE_DIR}/./data/" "${TMPDIR}/"
rsync -az --relative "${FROM}:${REMOTE_DIR}/./store/" "${TMPDIR}/"
rsync -az --relative "${FROM}:${REMOTE_DIR}/./groups/" "${TMPDIR}/"
# .env is optional
rsync -az --relative "${FROM}:${REMOTE_DIR}/./.env" "${TMPDIR}/" 2>/dev/null || true

# Push to destination
echo "    Pushing to ${TO}..."
rsync -az "${TMPDIR}/${REMOTE_DIR}/" "${TO}:${REMOTE_DIR}/"

# --- Delete fleet config on destination (auto-discovery regenerates it) ---
echo "==> Removing fleet config on ${TO} (will be regenerated)"
ssh "${TO}" "rm -f ${REMOTE_DIR}/data/ssh-fleet.json"

# --- Start orchestrator on destination ---
echo "==> Starting nanoclaw on ${TO}"
ssh "${TO}" "systemctl --user restart nanoclaw.service"
sleep 3

if ssh "${TO}" "systemctl --user is-active --quiet nanoclaw.service"; then
  echo "    Running on ${TO}."
else
  echo "ERROR: nanoclaw failed to start on ${TO}"
  ssh "${TO}" "systemctl --user status nanoclaw.service --no-pager" || true
  echo ""
  echo "You may need to manually start on ${FROM} to recover:"
  echo "  ssh ${FROM} 'systemctl --user start nanoclaw.service'"
  exit 1
fi

# --- Disable service on source (becomes agent-only) ---
echo "==> Disabling nanoclaw service on ${FROM}"
ssh "${FROM}" "systemctl --user disable nanoclaw.service" || true

echo ""
echo "  Migration complete: ${FROM} → ${TO}"
echo ""
echo "  Orchestrator: ${TO}"
echo "  ${FROM} is now agent-only (service disabled)"
echo ""
echo "  Verify:"
echo "    ssh ${TO} 'journalctl --user -u nanoclaw -f'"
echo ""
echo "  To migrate back:"
echo "    $0 ${TO} ${FROM}"
echo ""
