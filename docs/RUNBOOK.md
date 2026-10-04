# GigPilot runbook

All commands run on gx10-01 from the source checkout
(`/home/legenex/Documents/Projects/GigPilot`). Runtime data is
`/srv/projects/gigpilot` — not a git working copy.
`DC` below is shorthand for:

```bash
DC="docker compose -p gigpilot -f /srv/projects/gigpilot/current/compose.yml --env-file /srv/projects/gigpilot/release.env"
```

## Health

```bash
curl -s http://127.0.0.1:4710/api/health   # web
curl -s http://127.0.0.1:4711/api/health   # app
curl -s http://127.0.0.1:4712/readyz       # worker (db + queue + scheduler)
$DC ps
docker inspect -f '{{.State.Health.Status}}' gigpilot-edge-1   # Tailscale edge
```

The dashboard's **Integrations** page shows each provider's live status (checked every
15 minutes by the worker, or on demand with "Test connection").

## Deploy / rollback

```bash
ops/gx10-01/scripts/deploy.sh                       # build + deploy current HEAD
SKIP_BUILD=1 GIGPILOT_TAG=gigpilot:<old-tag> ops/gx10-01/scripts/deploy.sh   # manual rollback
cat /srv/projects/gigpilot/notes/releases.log
```

Deploys take a verified pre-deploy backup (and abort if it fails), snapshot the ops config
into `/srv/projects/gigpilot/releases/<tag>` (`current` → the live one), re-apply the
least-privilege DB role, run migrations as a one-shot service, wait for health checks,
smoke-test web/app/worker and the Tailscale edge, and on failure roll back to the previous
release's image **and** config snapshot, smoke-check the rollback and log
`ROLLBACK_FAILED` if it didn't recover. Migrations must stay expand-only (old image keeps
working against the new schema). Old GigPilot images are pruned (current + previous + 2).

## Restart & recovery

- Containers (including the Caddy `edge` on the Tailscale IP) use `restart: unless-stopped`,
  so everything returns after a reboot; the edge keeps retrying until Tailscale is up.
- Restart one service: `$DC restart worker`. **Never `restart` the whole project** — it
  re-runs the one-shot `migrate` while the database is restarting; use `$DC up -d` instead. Background jobs are durable in Postgres
  (pg-boss): in-flight jobs expire and retry per queue policy; failed attempts remain in
  `agent_run` history.
- If the Tailscale IP changes, update `WEB_URL`/`APP_URL` in
  `/srv/projects/gigpilot/config/gigpilot.env` and `$DC up -d`.

## Watchdog & alerts

`gigpilot-watchdog.timer` (every 3 min) checks worker `/readyz` and app/web health; after 3
consecutive failures it restarts that container. Failures, restarts and failed units
(backup via `OnFailure=`) are written to `/srv/projects/gigpilot/status/alerts.log` and the
user journal (`journalctl --user -t gigpilot-watchdog -t gigpilot-alert -p err`). Check
this file first in the morning. The worker also exits by itself when it has been unready
for more than 10 minutes, so Docker restarts it.

## Logs

```bash
$DC logs -f --tail=200 worker     # JSON logs; correlate by jobId / runId
$DC logs -f --tail=200 app
```

## Backups

- Nightly `gigpilot-backup.timer` (03:05) → `/srv/projects/gigpilot/backups/`
  (pg_dump custom format + storage tarball, 14 kept), then gx-backup's restic snapshot
  (03:30) copies `/srv/projects` encrypted to local + gx10-02 repositories.
- Manual: `ops/gx10-01/scripts/backup.sh` (nightly retention) or `--label <name>`; every dump
  is verified with `pg_restore --list`; the script exits non-zero if anything is skipped.
- Restore (stops the apps, restores in one transaction, re-applies the runtime role and
  pg-boss ownership, optionally replaces the storage volume, restarts, smoke-checks):
  `ops/gx10-01/scripts/restore.sh <db.dump> [--storage <storage.tgz>] --yes-replace-database`
  (a `prerestore` safety backup is taken first). Rehearse quarterly.

## Credentials

Add provider keys in the dashboard (**Integrations → Credentials**, encrypted per workspace)
or server-wide as a secret file + env var. Never paste keys into chat, commits or logs.

| Provider | Credential | Where to get it |
|---|---|---|
| Factory.ai | `FACTORY_API_KEY` + install `droid` CLI; `FACTORY_ALLOW_IN_PROCESS=true` only after isolating droid (it can read the worker's secrets) | app.factory.ai/settings/api-keys |
| xAI / Grok | `XAI_API_KEY` | console.x.ai |
| Kie.ai | `KIE_API_KEY` | kie.ai/api-key |
| Higgsfield | `HIGGSFIELD_API_KEY` + `HIGGSFIELD_API_SECRET` | console.higgsfield.ai |
| Freelancer | `FREELANCER_OAUTH_TOKEN` (app approval or personal token) | accounts.freelancer.com/settings/develop |
| Upwork | OAuth app (client id/secret) + user access token | Upwork API key request (internal use) |

## Workspaces, operator credentials and sign-up

- Every sign-up gets its own workspace (demo mode by default on gx10-01).
- **Operator workspaces** are those whose owner/admin email is listed in `OPERATOR_EMAILS`
  (`/srv/projects/gigpilot/config/gigpilot.env`, exact addresses). Only they may use the
  server-wide provider credentials (env / secret files). Every other workspace must store its
  own keys under Integrations. The local GX gateway key is the one shareable credential
  (quota-limited per workspace per day). List only accounts that already exist — the first
  sign-up with an address owns it. A startup warning is logged for listed addresses with no account.
  **Procedure:** sign up with your own address first, then set `OPERATOR_EMAILS=<that address>`
  in the config file and run `$DC up -d app worker`. (It is intentionally empty until then.)
- Non-operator workspaces can never set a daily paid limit above `TENANT_MAX_DAILY_PAID_USD`
  (default 0); operators are capped by `PAID_PROVIDER_DAILY_BUDGET_USD`.
- `SIGNUP_MODE=invite` accepts exact addresses from `AUTH_ALLOWED_EMAILS`; `@domain` entries need
  `AUTH_REQUIRE_EMAIL_VERIFICATION=true` (requires an email sender — not configured in V1).
- Sign-in backoff: 5 failed passwords for one email within 15 minutes locks that email for 15
  minutes (IP-independent). Per-IP limits rely on the Caddy edge overwriting `X-Forwarded-For`.
- Remove throwaway accounts: `ops/gx10-01/scripts/purge-test-accounts.sh --yes`.

## Inbound marketplace notifications (Contra / Fiverr / Upwork emails)

Generate a per-workspace secret in **Integrations → Inbound notifications** (shown once). The
forwarder POSTs to `/api/inbound/<provider>?tenant=<workspace-slug>` with headers
`x-gigpilot-timestamp` (unix seconds) and `x-gigpilot-signature` = hex HMAC-SHA256 of
`<timestamp>.<workspace-slug>.<provider>.<raw body>`. Requests older than 5 minutes, replays and
bad signatures are rejected with an identical 401/409.

## Enabling real spend (owner decision)

Paid providers are never called while either budget is 0:

1. Server: set `PAID_PROVIDER_DAILY_BUDGET_USD=<n>` in `/srv/projects/gigpilot/config/gigpilot.env`, `$DC up -d`.
2. Workspace: **Settings → Limits → Daily paid spend limit** (operator workspace; others need
   `TENANT_MAX_DAILY_PAID_USD` > 0 and their own provider keys).

Per-job spend limits, attempt limits and repair limits still apply.

## AgentOS

GigPilot is a registered AgentOS software project. Hermes VPS is the control
plane; autonomous software work runs on gx10-01 via `execution/registry.yaml`
lane `gx10` at `/home/legenex/Documents/Projects/GigPilot`. Buzz channel
`#gigpilot` (`b79f3679-2bf2-4667-b53a-d386f7370e23`). Kanban board `gigpilot`.

The product still exposes a pull-only supervision API on `127.0.0.1:4712` and
writes `/srv/projects/gigpilot/status/agentos.json` every minute. Descriptor:
`ops/agentos/`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Site unreachable over Tailscale | `docker logs gigpilot-edge-1`; `tailscale ip -4`; `curl 127.0.0.1:4710/api/health` |
| Opportunities not arriving | Integrations page source status; `$DC logs worker | grep source-refresh`; `WORKER_SCHEDULES_ENABLED` |
| GX shows "Needs configuration" | `/srv/projects/gigpilot/secrets/gx_api_key` present; worker on `gx_gateway` network |
| Analyses all say "mock-deterministic" | GX unhealthy or overloaded — see Integrations; mock fallback is expected then |
| "Budget blocked" events | Paid spend disabled or job spend limit reached — by design |
