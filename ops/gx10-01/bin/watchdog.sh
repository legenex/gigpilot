#!/usr/bin/env bash
# gigpilot-watchdog: Docker restart policies ignore health, so an unhealthy but
# running container would stay broken overnight. Every few minutes this checks
# worker readiness and app/web health; after 3 consecutive failures it restarts
# the failing GigPilot container and raises an alert (journal priority err +
# /srv/projects/gigpilot/status/alerts.log).
set -uo pipefail
RT=/srv/projects/gigpilot
STATE="$RT/status/watchdog.state"
ALERTS="$RT/status/alerts.log"
THRESHOLD="${GIGPILOT_WATCHDOG_THRESHOLD:-3}"
declare -A checks=(
  [gigpilot-worker-1]="http://127.0.0.1:4712/readyz"
  [gigpilot-app-1]="http://127.0.0.1:4711/api/health"
  [gigpilot-web-1]="http://127.0.0.1:4710/api/health"
)
touch "$STATE"
alert() {
  local msg="$1"
  echo "$(date -u +%FT%TZ) ALERT $msg" >> "$ALERTS"
  logger -t gigpilot-watchdog -p user.err "ALERT $msg" 2>/dev/null || echo "ALERT $msg" >&2
}
for c in "${!checks[@]}"; do
  docker ps --format '{{.Names}}' | grep -qx "$c" || { alert "$c is not running"; continue; }
  fails="$(sed -n "s/^$c=//p" "$STATE")"; fails="${fails:-0}"
  if curl -fsS -m 10 "${checks[$c]}" >/dev/null 2>&1; then
    fails=0
  else
    fails=$((fails + 1))
    if (( fails >= THRESHOLD )); then
      alert "$c failed ${fails} consecutive health checks (${checks[$c]}) — restarting"
      docker restart "$c" >/dev/null 2>&1 || alert "restart of $c failed"
      fails=0
    fi
  fi
  { grep -v "^$c=" "$STATE" || true; echo "$c=$fails"; } > "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
done
