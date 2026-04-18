#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  agoraiq-smart-alerts — deployment helper (VPS)
#
#  Idempotent: safe to re-run. Assumes /opt/agoraiq-smart-alerts is
#  the deploy target and that the VPS already has Node 18+, pm2, a
#  running PostgreSQL, and Redis.
#
#  Environment expected in /opt/agoraiq-smart-alerts/.env
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="/opt/agoraiq-smart-alerts"
PG_USER="agoraiq_smart_alerts"
PG_DB="agoraiq_smart_alerts"

[[ $EUID -eq 0 ]] || { echo "must run as root"; exit 1; }

echo "── Ensure deploy dir"
mkdir -p "$APP_DIR/logs"

echo "── Copy code (rsync excludes node_modules and env)"
rsync -a --delete --exclude node_modules --exclude .env --exclude logs \
  "$(dirname "$0")/../"  "$APP_DIR/"

echo "── Install deps"
cd "$APP_DIR"
npm ci --omit=dev

echo "── Ensure DB exists (creates role/db if missing)"
su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'\"" | grep -q 1 \
  || su - postgres -c "psql -c \"CREATE ROLE ${PG_USER} LOGIN;\""
su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${PG_DB}'\"" | grep -q 1 \
  || su - postgres -c "createdb -O ${PG_USER} ${PG_DB}"

echo "── Run migrations"
node src/migrate.js

echo "── PM2 start/reload"
if pm2 describe smart-alerts-api >/dev/null 2>&1; then
  pm2 reload ecosystem.config.js
else
  pm2 start ecosystem.config.js
fi
pm2 save

cat <<EOF

══════════════════════════════════════════════════════════════════
 smart-alerts-api deployed.

 Caddy snippet to add (inside your site block):

   reverse_proxy /api/smart-alerts/*  127.0.0.1:4310

 Verify:
   curl -s http://127.0.0.1:4310/api/internal/health | jq
══════════════════════════════════════════════════════════════════
EOF
