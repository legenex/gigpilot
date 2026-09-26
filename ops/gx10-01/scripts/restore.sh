#!/usr/bin/env bash
# Restore a GigPilot database dump. DESTRUCTIVE for the target database —
# requires an explicit dump path and the confirmation flag.
#   restore.sh /srv/projects/gigpilot/backups/gigpilot-db-<ts>.dump --yes-replace-database
set -euo pipefail
DUMP="${1:?dump path required}"
[[ "${2:-}" == "--yes-replace-database" ]] || { echo "refusing without --yes-replace-database" >&2; exit 2; }
docker exec -i gigpilot-db-1 pg_restore -U gigpilot -d gigpilot --clean --if-exists --no-owner < "$DUMP"
echo "restored $DUMP"
