#!/usr/bin/env bash
# Dumps the GigPilot database (pg_dump custom format, verified with
# pg_restore --list) and archives the asset storage volume into
# /srv/projects/gigpilot/backups (0700). gx-backup's nightly restic snapshot of
# /srv/projects picks these up (encrypted, cross-node copy).
#   backup.sh                   nightly backup (keeps GIGPILOT_BACKUP_KEEP, default 14)
#   backup.sh --label predeploy pre-deploy backup (keeps 5)
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
cleanup() { rm -f "$DEST"/*.partial; }
trap cleanup EXIT

fail() { echo "backup FAILED: $*" >&2; echo "$TS backup FAILED ($LABEL): $*" >> "$RT/notes/backups.log"; exit 1; }

docker ps --format '{{.Names}}' | grep -qx gigpilot-db-1 || fail "gigpilot-db-1 is not running"

DB_FILE="$DEST/gigpilot-db-$LABEL-$TS.dump"
docker exec gigpilot-db-1 pg_dump -U gigpilot -d gigpilot -Fc > "$DB_FILE.partial" || fail "pg_dump failed"
docker exec -i gigpilot-db-1 pg_restore --list < "$DB_FILE.partial" > /dev/null || fail "dump did not verify (pg_restore --list)"
mv "$DB_FILE.partial" "$DB_FILE"
echo "db backup: $DB_FILE ($(stat -c %s "$DB_FILE") bytes)"

if docker volume inspect gigpilot_storage >/dev/null 2>&1; then
  ST_FILE="$DEST/gigpilot-storage-$LABEL-$TS.tgz"
  docker run --rm --network none -v gigpilot_storage:/data:ro postgres:17-bookworm \
    tar -C /data -czf - . > "$ST_FILE.partial" || fail "storage archive failed"
  mv "$ST_FILE.partial" "$ST_FILE"
  echo "storage backup: $ST_FILE"
fi

# retention per label (legacy unlabelled files count as nightly)
prune() { ls -1t $1 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f; }
if [[ "$LABEL" == nightly ]]; then
  prune "$DEST/gigpilot-db-nightly-*.dump $DEST/gigpilot-db-2*.dump"
  prune "$DEST/gigpilot-storage-nightly-*.tgz $DEST/gigpilot-storage-2*.tgz"
else
  prune "$DEST/gigpilot-db-$LABEL-*.dump"
  prune "$DEST/gigpilot-storage-$LABEL-*.tgz"
fi
echo "$TS backup ok ($LABEL)" >> "$RT/notes/backups.log"
