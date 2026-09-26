#!/usr/bin/env bash
# Restore GigPilot from a backup. DESTRUCTIVE for the target database.
#   restore.sh <db-dump> [--storage <storage.tgz>] --yes-replace-database
# Steps: stop web/app/worker/edge → pg_restore in one transaction → re-apply the
# least-privilege runtime role (pg-boss schema ownership + grants) → optionally
# replace the storage volume → start the stack and smoke-check.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
RT=/srv/projects/gigpilot
DUMP="${1:?usage: restore.sh <db-dump> [--storage <tgz>] --yes-replace-database}"; shift
STORAGE=""; CONFIRM=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --storage) STORAGE="${2:?}"; shift 2 ;;
    --yes-replace-database) CONFIRM=1; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
[[ -n "$CONFIRM" ]] || { echo "refusing without --yes-replace-database" >&2; exit 2; }
[[ -r "$DUMP" ]] || { echo "cannot read $DUMP" >&2; exit 2; }
docker exec -i gigpilot-db-1 pg_restore --list < "$DUMP" >/dev/null || { echo "dump does not verify" >&2; exit 1; }

DIR="$(readlink -f "$RT/current" 2>/dev/null || echo "$REPO/ops/gx10-01")"
DC=(docker compose -p gigpilot -f "$DIR/compose.yml" --env-file "$RT/release.env")

echo "==> safety backup of the current database"
"$REPO/ops/gx10-01/scripts/backup.sh" --label prerestore || { echo "safety backup failed — aborting" >&2; exit 1; }

echo "==> stopping application services"
"${DC[@]}" stop edge web app worker

echo "==> restoring $DUMP"
docker exec -i gigpilot-db-1 pg_restore -U gigpilot -d gigpilot --clean --if-exists --no-owner --single-transaction < "$DUMP"

echo "==> re-applying least-privilege runtime role"
{ printf "\\set app_password '%s'\n" "$(cat "$RT/secrets/postgres_app_password")"; cat "$DIR/sql/app-role.sql"; } \
  | docker exec -i gigpilot-db-1 psql -q -U gigpilot -d gigpilot -v ON_ERROR_STOP=1 -f - >/dev/null

if [[ -n "$STORAGE" ]]; then
  echo "==> restoring storage volume from $STORAGE"
  docker run --rm -i --network none -v gigpilot_storage:/data postgres:17-bookworm \
    sh -c 'find /data -mindepth 1 -delete && tar -C /data -xzf - && chown -R 10001:10001 /data' < "$STORAGE"
fi

echo "==> starting services"
"${DC[@]}" up -d --wait --wait-timeout 240
curl -fsS -m 10 http://127.0.0.1:4711/api/health >/dev/null && curl -fsS -m 10 http://127.0.0.1:4712/readyz >/dev/null \
  && echo "restore complete — health OK" || { echo "!! services not healthy after restore" >&2; exit 1; }
