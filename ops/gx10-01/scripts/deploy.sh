#!/usr/bin/env bash
# Build and deploy the GigPilot stack on gx10-01.
#   * explicit image tags gigpilot:<sha12>[-dirty]-<ts> (never :latest in releases)
#   * deploy lock, free-memory guard, low-priority build
#   * pre-deploy database backup
#   * one-shot migrate service, `up --wait` on health checks
#   * smoke checks; automatic rollback to the previous release on failure
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
RT=/srv/projects/gigpilot
COMPOSE=(docker compose -p gigpilot -f "$REPO/ops/gx10-01/compose.yml" --env-file "$RT/release.env")
MIN_GIB="${GIGPILOT_MIN_AVAILABLE_GIB:-6}"

exec 9>"$RT/deploy.lock"
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }

avail_gib=$(( $(awk '/MemAvailable/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
(( avail_gib >= MIN_GIB )) || { echo "only ${avail_gib} GiB available (< ${MIN_GIB}); refusing to build" >&2; exit 1; }

cd "$REPO"
sha="$(git rev-parse --short=12 HEAD)"
dirty=""; git diff --quiet HEAD -- . ':!*.md' 2>/dev/null || dirty="-dirty"
ts="$(date -u +%Y%m%dt%H%M%Sz)"
TAG="${GIGPILOT_TAG:-gigpilot:${sha}${dirty}-${ts}}"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> building $TAG"
  nice -n 10 docker build -f ops/docker/Dockerfile --build-arg GIT_SHA="${sha}${dirty}" -t "$TAG" .
fi
docker image inspect "$TAG" >/dev/null

PREV=""
[[ -s "$RT/release.env" ]] && PREV="$(sed -n 's/^GIGPILOT_IMAGE=//p' "$RT/release.env")"

if docker ps --format '{{.Names}}' | grep -qx gigpilot-db-1; then
  echo "==> pre-deploy backup"
  "$REPO/ops/gx10-01/scripts/backup.sh" || echo "WARN: backup failed (continuing)"
fi

echo "GIGPILOT_IMAGE=$TAG" > "$RT/release.env"
echo "==> deploying $TAG"
if ! "${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 240; then
  echo "!! compose up failed" >&2
  FAILED=1
fi

smoke() {
  curl -fsS -m 10 http://127.0.0.1:4710/api/health >/dev/null &&
  curl -fsS -m 10 http://127.0.0.1:4711/api/health >/dev/null &&
  curl -fsS -m 10 http://127.0.0.1:4712/readyz >/dev/null
}
if [[ "${FAILED:-0}" != "1" ]]; then
  for _ in 1 2 3 4 5 6; do smoke && break; sleep 5; done
  smoke || FAILED=1
fi

if [[ "${FAILED:-0}" == "1" ]]; then
  echo "!! smoke checks failed for $TAG" >&2
  "${COMPOSE[@]}" ps >&2 || true
  if [[ -n "$PREV" && "$PREV" != "$TAG" ]]; then
    echo "==> rolling back to $PREV" >&2
    echo "GIGPILOT_IMAGE=$PREV" > "$RT/release.env"
    "${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 240 || true
  fi
  echo "$(date -u +%FT%TZ) FAILED $TAG (rolled back to ${PREV:-none})" >> "$RT/notes/releases.log"
  exit 1
fi

echo "$(date -u +%FT%TZ) OK $TAG" >> "$RT/notes/releases.log"
echo "==> deployed $TAG"
"${COMPOSE[@]}" ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'
