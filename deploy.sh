#!/usr/bin/env bash
set -euo pipefail

# ── Configure these once ──────────────────────────────────────────────────────
PI_USER="${PI_USER:-pi}"
PI_HOST="${PI_HOST:-raspberry.local}"
PI_PATH="${PI_PATH:-/home/pi/MagicMirror/modules/MMM-SpotifySonos}"
# ─────────────────────────────────────────────────────────────────────────────

echo "→ Syncing to ${PI_USER}@${PI_HOST}:${PI_PATH}"
rsync -az --delete \
  --exclude='.git/' \
  --exclude='.githooks/' \
  --exclude='node_modules/' \
  --exclude='.token.json' \
  --exclude='.ssl-*.pem' \
  --exclude='test/' \
  "$(git rev-parse --show-toplevel)/" \
  "${PI_USER}@${PI_HOST}:${PI_PATH}"

echo "→ Installing dependencies on Pi"
ssh "${PI_USER}@${PI_HOST}" "cd '${PI_PATH}' && npm install --omit=dev --silent"

echo "→ Restarting MagicMirror"
ssh "${PI_USER}@${PI_HOST}" "pm2 restart ~/mm.sh"

echo "✓ Done"
