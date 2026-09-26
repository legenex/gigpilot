#!/usr/bin/env bash
# One-time (idempotent) host setup for GigPilot on gx10-01:
#   runtime dirs, secrets (generated if missing), config env, external volumes,
#   systemd user units (Tailscale proxy ×2, nightly backup timer).
# Never prints secret values.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
RT=/srv/projects/gigpilot
SHARE="$HOME/.local/share/gigpilot"
UNITS="$HOME/.config/systemd/user"

mkdir -p "$RT"/{secrets,config,backups,notes,status} "$SHARE/bin" "$UNITS"
chmod 700 "$RT" "$RT/secrets" "$RT/backups"
# container uid 10001 writes the AgentOS status snapshot here (parent dir is 0700)
chmod 777 "$RT/status"

gen() { # gen <file> <cmd>
  local f="$RT/secrets/$1"
  if [[ ! -s "$f" ]]; then (umask 077; eval "$2" > "$f"); echo "generated secret: $1"; fi
}
gen postgres_password "openssl rand -hex 24"
gen postgres_app_password "openssl rand -hex 24"
gen better_auth_secret "openssl rand -base64 48 | tr -d '\n'"
gen encryption_key "openssl rand -base64 32 | tr -d '\n'"
gen agentos_supervision_token "openssl rand -hex 32"
gen inbound_webhook_secret "openssl rand -hex 32"
[[ -s "$RT/secrets/gx_api_key" ]] || { echo "WARN: $RT/secrets/gx_api_key missing — GX will show 'Needs configuration'"; : > "$RT/secrets/gx_api_key"; }
# Compose (non-swarm) bind-mounts secret files with host ownership; the
# container user is 10001, so files are 0644 inside the 0700 secrets dir.
chmod 644 "$RT"/secrets/*

TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
TS_NAME="$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || echo gx10-01)"
if [[ ! -s "$RT/config/gigpilot.env" ]]; then
  cat > "$RT/config/gigpilot.env" <<CONF
# GigPilot runtime config (non-secret). Secrets live in $RT/secrets.
NODE_ENV=production
LOG_LEVEL=info
WEB_URL=http://${TS_IP:-100.105.214.61}:4710
APP_URL=http://${TS_IP:-100.105.214.61}:4711
CANONICAL_WEB_URL=https://gigpilot.ai
CANONICAL_APP_URL=https://app.gigpilot.ai
AUTH_TRUSTED_ORIGINS=http://${TS_NAME}:4710,http://${TS_NAME}:4711,http://127.0.0.1:4710,http://127.0.0.1:4711,http://localhost:4710,http://localhost:4711
SIGNUP_MODE=open
DEMO_SEED_ON_SIGNUP=true
GX_BASE_URL=http://gx-litellm:4000/v1
GX_MAX_CONCURRENCY=2
STORAGE_DRIVER=filesystem
WORKER_SCHEDULES_ENABLED=true
# Real-money guardrail — paid providers stay off while this is 0.
PAID_PROVIDER_DAILY_BUDGET_USD=0
# Operator workspaces (exact owner emails) may use server-wide credentials.
OPERATOR_EMAILS=
# Paid-spend ceiling for non-operator workspaces (0 = none).
TENANT_MAX_DAILY_PAID_USD=0
# GigPilot's share of gx-code (1 slot per node, shared with AgentOS).
GX_CODE_MAX_CONCURRENCY=1
CONF
  chmod 644 "$RT/config/gigpilot.env"
  echo "wrote $RT/config/gigpilot.env"
fi

docker volume inspect gigpilot_pgdata >/dev/null 2>&1 || docker volume create gigpilot_pgdata >/dev/null
docker volume inspect gigpilot_storage >/dev/null 2>&1 || docker volume create gigpilot_storage >/dev/null

install -m 0755 "$REPO/ops/gx10-01/scripts/backup.sh" "$SHARE/bin/backup.sh"
install -m 0755 "$REPO/ops/gx10-01/bin/watchdog.sh" "$SHARE/bin/watchdog.sh"
install -m 0755 "$REPO/ops/gx10-01/bin/alert.sh" "$SHARE/bin/alert.sh"
install -m 0644 "$REPO/ops/gx10-01/systemd/gigpilot-backup.service" "$UNITS/"
install -m 0644 "$REPO/ops/gx10-01/systemd/gigpilot-backup.timer" "$UNITS/"
install -m 0644 "$REPO/ops/gx10-01/systemd/gigpilot-watchdog.service" "$UNITS/"
install -m 0644 "$REPO/ops/gx10-01/systemd/gigpilot-watchdog.timer" "$UNITS/"
install -m 0644 "$REPO/ops/gx10-01/systemd/gigpilot-alert@.service" "$UNITS/"
systemctl --user daemon-reload
# Tailscale exposure is the compose `edge` service (Caddy); retire legacy socat units.
for u in gigpilot-ts-proxy@4710 gigpilot-ts-proxy@4711; do systemctl --user disable --now "$u" >/dev/null 2>&1 || true; done
rm -f "$UNITS/gigpilot-ts-proxy@.service" "$SHARE/bin/ts-proxy.sh"
systemctl --user daemon-reload
systemctl --user enable --now gigpilot-backup.timer gigpilot-watchdog.timer
echo "host setup complete"
