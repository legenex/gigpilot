#!/usr/bin/env bash
# Delete throwaway test/audit accounts (and their workspaces, via cascades)
# from the GigPilot database. Matches only addresses at example.com /
# gigpilot.dev test domains. Dry-run by default.
#   purge-test-accounts.sh            # list what would be deleted
#   purge-test-accounts.sh --yes      # delete
set -euo pipefail
DB="${GIGPILOT_DB:-gigpilot}"
WHERE="email ~* '@(example\\.com|gigpilot\\.dev)$'"
psqlc() { docker exec -i gigpilot-db-1 psql -U gigpilot -d "$DB" -v ON_ERROR_STOP=1 -At "$@"; }
echo "matching accounts in $DB:"
psqlc -c "select email from \"user\" where $WHERE order by created_at"
[[ "${1:-}" == "--yes" ]] || { echo "(dry run — pass --yes to delete)"; exit 0; }
psqlc <<SQL
begin;
delete from tenant where id in (
  select m.tenant_id from membership m join "user" u on u.id = m.user_id
  where u.$WHERE
    and not exists (select 1 from membership m2 join "user" u2 on u2.id = m2.user_id
                    where m2.tenant_id = m.tenant_id and not (u2.$WHERE))
);
delete from "user" where $WHERE;
-- Drop queued pg-boss work left behind by the removed workspaces so a deleted
-- tenant's background jobs cannot hold the shared heavy-model slot.
delete from pgboss.job j
where j.state in ('created', 'retry', 'active')
  and (j.data->>'tenantId') is not null
  and (j.data->>'tenantId') ~ '^[0-9a-f-]{36}$'
  and (j.data->>'tenantId')::uuid not in (select id from tenant);
commit;
SQL
echo "deleted."
