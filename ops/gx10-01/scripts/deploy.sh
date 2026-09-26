#!/usr/bin/env bash
# Build and deploy the GigPilot stack on gx10-01.
#   * explicit image tags gigpilot:<sha12>[-dirty]-<ts> (never :latest in releases)
#   * deploy lock, free-memory guard, low-priority build
#   * pre-deploy database backup (deploy aborts if it fails)
#   * per-release snapshot of the ops config (compose, Caddyfile, SQL) under
#     /srv/projects/gigpilot/releases/<tag> — production never mounts the dev tree
#   * least-privilege runtime role re-applied, one-shot migrate, `up --wait`
#   * smoke checks incl. the Tailscale edge; automatic rollback to the previous
#     release (image AND its config snapshot), smoke-checked, loudly logged
#   * prunes old GigPilot images (keeps current, previous and 2 more)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
RT=/srv/projects/gigpilot
RELEASES="$RT/releases"
MIN_GIB="${GIGPILOT_MIN_AVAILABLE_GIB:-6}"
mkdir -p "$RELEASES" "$RT/notes"

exec 9>"$RT/deploy.lock"
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }

avail_gib=$(( $(awk '/MemAvailable/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
(( avail_gib >= MIN_GIB )) || { echo "only ${avail_gib} GiB available (< ${MIN_GIB}); refusing to build" >&2; exit 1; }

cd "$REPO"
sha="$(git rev-parse --short=12 HEAD)"
dirty=""; git diff --quiet HEAD -- . ':!*.md' ':!.ai' 2>/dev/null || dirty="-dirty"
ts="$(date -u +%Y%m%dt%H%M%Sz)"
TAG="${GIGPILOT_TAG:-gigpilot:${sha}${dirty}-${ts}}"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> building $TAG"
  nice -n 10 docker build -f ops/docker/Dockerfile --build-arg GIT_SHA="${sha}${dirty}" -t "$TAG" .
fi
docker image inspect "$TAG" >/dev/null

# --- previous release (for rollback) ----------------------------------------
PREV_IMAGE=""; PREV_DIR=""
if [[ -s "$RT/release.env" ]]; then
  PREV_IMAGE="$(sed -n 's/^GIGPILOT_IMAGE=//p' "$RT/release.env")"
  PREV_DIR="$(sed -n 's/^GIGPILOT_RELEASE_DIR=//p' "$RT/release.env")"
fi
[[ -n "$PREV_DIR" && -f "$PREV_DIR/compose.yml" ]] || PREV_DIR=""

TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
[[ "$TS_IP" == 100.* ]] || TS_IP="$(sed -n 's/^GIGPILOT_TS_IP=//p' "$RT/release.env" 2>/dev/null || true)"
TS_IP="${TS_IP:-100.105.214.61}"

# --- snapshot this release's ops config -------------------------------------
REL_NAME="${TAG#gigpilot:}"
SNAP="$RELEASES/$REL_NAME"
rm -rf "$SNAP.tmp" && mkdir -p "$SNAP.tmp"
cp -a ops/gx10-01/compose.yml ops/gx10-01/edge ops/gx10-01/initdb ops/gx10-01/sql "$SNAP.tmp/"
rm -rf "$SNAP" && mv "$SNAP.tmp" "$SNAP"

compose() { # compose <release-dir> <image> <args...>
  local dir="$1" image="$2"; shift 2
  GIGPILOT_IMAGE="$image" GIGPILOT_TS_IP="$TS_IP" docker compose -p gigpilot -f "$dir/compose.yml" "$@"
}
write_release() { # write_release <image> <dir>
  printf 'GIGPILOT_IMAGE=%s\nGIGPILOT_TS_IP=%s\nGIGPILOT_RELEASE_DIR=%s\n' "$1" "$TS_IP" "$2" > "$RT/release.env"
  ln -sfn "$2" "$RT/current"
}

# Legacy socat units were replaced by the Caddy edge.
for u in gigpilot-ts-proxy@4710 gigpilot-ts-proxy@4711; do
  systemctl --user is-enabled "$u" >/dev/null 2>&1 && systemctl --user disable --now "$u" >/dev/null 2>&1 || true
done

# --- backup (abort on failure) ----------------------------------------------
if docker ps --format '{{.Names}}' | grep -qx gigpilot-db-1; then
  echo "==> pre-deploy backup"
  if ! "$REPO/ops/gx10-01/scripts/backup.sh" --label predeploy; then
    echo "!! pre-deploy backup failed — aborting deploy (nothing changed)" >&2
    echo "$(date -u +%FT%TZ) ABORTED $TAG (backup failed)" >> "$RT/notes/releases.log"
    exit 1
  fi
fi

echo "==> ensuring database + least-privilege runtime role"
compose "$SNAP" "$TAG" up -d --wait db
[[ -s "$RT/secrets/postgres_app_password" ]] || (umask 077; openssl rand -hex 24 > "$RT/secrets/postgres_app_password"; chmod 644 "$RT/secrets/postgres_app_password")
{ printf "\\set app_password '%s'\n" "$(cat "$RT/secrets/postgres_app_password")"; cat "$SNAP/sql/app-role.sql"; } \
  | docker exec -i gigpilot-db-1 psql -q -U gigpilot -d gigpilot -v ON_ERROR_STOP=1 -f - >/dev/null

smoke() {
  curl -fsS -m 10 http://127.0.0.1:4710/api/health >/dev/null &&
  curl -fsS -m 10 http://127.0.0.1:4711/api/health >/dev/null &&
  curl -fsS -m 10 http://127.0.0.1:4712/readyz >/dev/null &&
  curl -fsS -m 10 "http://${TS_IP}:4710/api/health" >/dev/null &&
  curl -fsS -m 10 "http://${TS_IP}:4711/api/health" >/dev/null
}
smoke_retry() { for _ in 1 2 3 4 5 6; do smoke && return 0; sleep 5; done; return 1; }

echo "==> deploying $TAG"
FAILED=0
compose "$SNAP" "$TAG" up -d --remove-orphans --wait --wait-timeout 240 || { echo "!! compose up failed" >&2; FAILED=1; }
[[ "$FAILED" == 1 ]] || smoke_retry || FAILED=1

if [[ "$FAILED" == 1 ]]; then
  echo "!! deploy of $TAG failed" >&2
  compose "$SNAP" "$TAG" ps >&2 || true
  if [[ -n "$PREV_IMAGE" && "$PREV_IMAGE" != "$TAG" ]]; then
    ROLLBACK_DIR="${PREV_DIR:-$SNAP}"
    echo "==> rolling back to $PREV_IMAGE (config: $ROLLBACK_DIR)" >&2
    if compose "$ROLLBACK_DIR" "$PREV_IMAGE" up -d --remove-orphans --wait --wait-timeout 240 && smoke_retry; then
      write_release "$PREV_IMAGE" "$ROLLBACK_DIR"
      echo "$(date -u +%FT%TZ) FAILED $TAG (rolled back to $PREV_IMAGE, smoke OK)" >> "$RT/notes/releases.log"
    else
      echo "$(date -u +%FT%TZ) FAILED $TAG; ROLLBACK_FAILED to $PREV_IMAGE — manual intervention required" >> "$RT/notes/releases.log"
      echo "!! ROLLBACK_FAILED — see docs/RUNBOOK.md" >&2
    fi
  else
    echo "$(date -u +%FT%TZ) FAILED $TAG (no previous release to roll back to)" >> "$RT/notes/releases.log"
  fi
  exit 1
fi

write_release "$TAG" "$SNAP"
echo "$(date -u +%FT%TZ) OK $TAG" >> "$RT/notes/releases.log"

# --- housekeeping: old release snapshots and GigPilot images only -----------
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +6 | while read -r d; do
  [[ "${d%/}" == "$SNAP" || "${d%/}" == "${PREV_DIR:-}" ]] || rm -rf "$d"
done
keep=("$TAG" "${PREV_IMAGE:-}")
mapfile -t others < <(docker images --format '{{.Repository}}:{{.Tag}}' | grep '^gigpilot:' | grep -vxF -e "$TAG" -e "${PREV_IMAGE:-none}" || true)
for img in "${others[@]:2}"; do docker rmi "$img" >/dev/null 2>&1 || true; done

echo "==> deployed $TAG"
compose "$SNAP" "$TAG" ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'
