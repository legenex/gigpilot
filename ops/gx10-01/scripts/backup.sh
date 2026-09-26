#!/usr/bin/env bash
# Dumps the GigPilot database (pg_dump custom format) and archives the asset
# storage volume into /srv/projects/gigpilot/backups (0700). gx-backup's nightly
# restic snapshot of /srv/projects picks these up (encrypted, cross-node copy).
set -euo pipefail
RT=/srv/projects/gigpilot
DEST="$RT/backups"
KEEP="${GIGPILOT_BACKUP_KEEP:-14}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$DEST"

if docker ps --format '{{.Names}}' | grep -qx gigpilot-db-1; then
  docker exec gigpilot-db-1 pg_dump -U gigpilot -d gigpilot -Fc > "$DEST/gigpilot-db-$TS.dump.partial"
  mv "$DEST/gigpilot-db-$TS.dump.partial" "$DEST/gigpilot-db-$TS.dump"
  echo "db backup: $DEST/gigpilot-db-$TS.dump ($(stat -c %s "$DEST/gigpilot-db-$TS.dump") bytes)"
else
  echo "gigpilot-db-1 not running; skipping db dump" >&2
fi

if docker volume inspect gigpilot_storage >/dev/null 2>&1; then
  docker run --rm --network none -v gigpilot_storage:/data:ro postgres:17-bookworm \
    tar -C /data -czf - . > "$DEST/gigpilot-storage-$TS.tgz.partial"
  mv "$DEST/gigpilot-storage-$TS.tgz.partial" "$DEST/gigpilot-storage-$TS.tgz"
  echo "storage backup: $DEST/gigpilot-storage-$TS.tgz"
fi

# retention
ls -1t "$DEST"/gigpilot-db-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
ls -1t "$DEST"/gigpilot-storage-*.tgz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "$TS backup ok" >> "$RT/notes/backups.log"
