#!/usr/bin/env bash
# Dumps the GigPilot database (pg_dump custom format; refuses a database with no
# user tables and a dump whose pg_restore --list has no TABLE DATA entries) and
# archives the asset storage volume into /srv/projects/gigpilot/backups (0700).
# gx-backup's nightly restic snapshot of /srv/projects picks these up (encrypted,
# cross-node copy).
#   backup.sh                   nightly backup (keeps GIGPILOT_BACKUP_KEEP, default 14)
#   backup.sh --label predeploy pre-deploy backup (keeps 5)
# With the stack down, the database is dumped "cold" from a throwaway copy of the
# gigpilot_pgdata volume (see below); the log line says live or cold.
# Exits non-zero if anything fails — never reports success for a skipped dump.
set -euo pipefail
RT=/srv/projects/gigpilot
DEST="$RT/backups"
LABEL="nightly"
[[ "${1:-}" == "--label" && -n "${2:-}" ]] && LABEL="$2"
case "$LABEL" in nightly) KEEP="${GIGPILOT_BACKUP_KEEP:-14}" ;; *) KEEP="${GIGPILOT_BACKUP_KEEP_PREDEPLOY:-5}" ;; esac
TS="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$DEST" "$RT/notes"
fail() { echo "backup FAILED: $*" >&2; echo "$TS backup FAILED ($LABEL): $*" >> "$RT/notes/backups.log"; exit 1; }

# One backup at a time: the stale-resource sweep below must never remove the disposable
# container of a run that is still going.
exec 9>"$DEST/.backup.lock"
flock -n 9 || fail "another backup.sh run holds $DEST/.backup.lock"
# Installed only once the lock is held: a run that loses the lock must not delete the
# .partial files of the run that holds it.
cleanup() { rm -f "$DEST"/*.partial; }
trap cleanup EXIT

# Every disposable container and volume of the cold path carries this label. Remove ones
# left by an earlier run that was killed before its EXIT trap ran; nothing without the
# label is touched.
COLD_LABEL=gigpilot.backup.cold=1
{ docker ps -aq --filter "label=$COLD_LABEL" | xargs -r docker rm -f >/dev/null \
  && docker volume ls -q --filter "label=$COLD_LABEL" | xargs -r docker volume rm >/dev/null; } \
  || fail "stale cold-resource sweep failed (docker unreachable, or a labelled volume is still in use)"

DB_CTR=gigpilot-db-1
MODE=live
if ! docker ps --format '{{.Names}}' | grep -qx gigpilot-db-1; then
  # Cold path: the stack is down (it has been since 2026-09-27), but its data volume still
  # holds the database, and gx-backup excludes /var/lib/docker. Copy the volume into a
  # throwaway volume, start a disposable Postgres on the copy (no network), and dump that
  # exactly like the live path. The real volume is only ever mounted read-only.
  docker volume inspect gigpilot_pgdata >/dev/null 2>&1 || fail "gigpilot-db-1 is not running and volume gigpilot_pgdata does not exist"
  [ -z "$(docker ps -q --filter volume=gigpilot_pgdata)" ] || fail "gigpilot_pgdata is in use by a container other than gigpilot-db-1"
  MODE=cold
  DB_CTR="gigpilot-backup-cold-$TS"
  cold_cleanup() { docker rm -f "$DB_CTR" >/dev/null 2>&1 || true; docker volume rm "$DB_CTR" >/dev/null 2>&1 || true; }
  trap 'cleanup; cold_cleanup' EXIT
  docker volume create --label "$COLD_LABEL" "$DB_CTR" >/dev/null
  docker run --rm --network none --label "$COLD_LABEL" -v gigpilot_pgdata:/src:ro -v "$DB_CTR":/dst postgres:17-bookworm \
    sh -c 'cp -a /src/. /dst/ && test "$(cat /dst/pgdata/PG_VERSION)" = 17 && test ! -e /dst/pgdata/postmaster.pid' \
    || fail "cold copy of gigpilot_pgdata failed (or it is not a cleanly stopped Postgres 17 cluster)"
  # Close the window between the in-use check and the copy: nothing may have mounted the
  # volume meanwhile, and the copy itself must be a cleanly shut down cluster.
  [ -z "$(docker ps -q --filter volume=gigpilot_pgdata)" ] || fail "gigpilot_pgdata was mounted by another container during the cold copy"
  CTL="$(docker run --rm --network none --label "$COLD_LABEL" -v "$DB_CTR":/dst:ro postgres:17-bookworm \
    pg_controldata /dst/pgdata)" || fail "pg_controldata failed on the cold copy of gigpilot_pgdata"
  grep -Eq '^Database cluster state:[[:space:]]+shut down$' <<< "$CTL" \
    || fail "cold copy of gigpilot_pgdata is not a cleanly shut down cluster (pg_controldata)"
  docker run -d --name "$DB_CTR" --label "$COLD_LABEL" --network none -e PGDATA=/var/lib/postgresql/data/pgdata \
    -v "$DB_CTR":/var/lib/postgresql/data postgres:17-bookworm >/dev/null || fail "cold Postgres did not start"
  for _ in $(seq 60); do
    docker exec "$DB_CTR" pg_isready -q -U gigpilot -d gigpilot 2>/dev/null && break
    sleep 1
  done
  docker exec "$DB_CTR" pg_isready -q -U gigpilot -d gigpilot || fail "cold Postgres not ready after 60 s"
fi

# Never record an empty database as a good backup (893-byte dumps of an empty database
# used to pass pg_restore --list).
TABLES="$(docker exec "$DB_CTR" psql -U gigpilot -d gigpilot -Atc 'select count(*) from pg_stat_user_tables')" \
  || fail "could not count user tables ($MODE)"
[[ "$TABLES" =~ ^[0-9]+$ && "$TABLES" -gt 0 ]] || fail "database gigpilot has no user tables ($MODE)"

DB_FILE="$DEST/gigpilot-db-$LABEL-$TS.dump"
docker exec "$DB_CTR" pg_dump -U gigpilot -d gigpilot -Fc > "$DB_FILE.partial" || fail "pg_dump failed ($MODE)"
TOC="$(docker exec -i "$DB_CTR" pg_restore --list < "$DB_FILE.partial")" || fail "dump did not verify (pg_restore --list)"
DATA_ENTRIES="$(grep -c ' TABLE DATA ' <<< "$TOC" || true)"
(( DATA_ENTRIES > 0 )) || fail "dump has no TABLE DATA entries ($MODE)"
mv "$DB_FILE.partial" "$DB_FILE"
echo "db backup ($MODE): $DB_FILE ($(stat -c %s "$DB_FILE") bytes, $TABLES user tables, $DATA_ENTRIES TABLE DATA entries)"

if docker volume inspect gigpilot_storage >/dev/null 2>&1; then
  ST_FILE="$DEST/gigpilot-storage-$LABEL-$TS.tgz"
  docker run --rm --network none -v gigpilot_storage:/data:ro postgres:17-bookworm \
    tar -C /data -czf - . > "$ST_FILE.partial" || fail "storage archive failed"
  mv "$ST_FILE.partial" "$ST_FILE"
  echo "storage backup: $ST_FILE"
fi

# retention per label (legacy unlabelled files count as nightly)
# (a pattern that matches nothing is fine: ls exits 2, which pipefail would turn into a failure)
prune() { { ls -1t $1 2>/dev/null || true; } | tail -n +"$((KEEP + 1))" | xargs -r rm -f; }
if [[ "$LABEL" == nightly ]]; then
  prune "$DEST/gigpilot-db-nightly-*.dump $DEST/gigpilot-db-2*.dump"
  prune "$DEST/gigpilot-storage-nightly-*.tgz $DEST/gigpilot-storage-2*.tgz"
else
  prune "$DEST/gigpilot-db-$LABEL-*.dump"
  prune "$DEST/gigpilot-storage-$LABEL-*.tgz"
fi
echo "$TS backup ok ($LABEL, $MODE)" >> "$RT/notes/backups.log"
