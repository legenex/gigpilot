# GigPilot on gx10-01 (internal V1, Tailscale only)

## Live URLs (tailnet only)

| Service | URL | Bind |
|---|---|---|
| Marketing site | http://100.105.214.61:4710 | docker `127.0.0.1:4710` ← Caddy `edge` on the Tailscale IP |
| Dashboard (app) | http://100.105.214.61:4711 | docker `127.0.0.1:4711` ← Caddy `edge` on the Tailscale IP |
| Worker health + supervision API | http://127.0.0.1:4712 (`/healthz`, `/readyz`, `/api/supervision/*`) | loopback only |
| PostgreSQL 17 | 127.0.0.1:4715 (db `gigpilot`; dev `gigpilot_dev`; tests `gigpilot_test`) | loopback only |

MagicDNS name: `gx10-01.taila7ef6a.ts.net` (trusted as an auth origin, but use the
IP URLs so the session cookie is shared between the site and the dashboard).

## Port allocation (GigPilot owns 4710–4729)

| Port | Use |
|---|---|
| 4710 | web (prod) |
| 4711 | app (prod) |
| 4712 | worker health/supervision (prod, loopback) |
| 4715 | postgres (loopback) |
| 4720 / 4721 / 4722 | web / app / worker in local development |
| 4713–4714, 4716–4719, 4723–4729 | reserved |

Verified free on 2026-09-26 (`ss -tlnp`); nothing else on the host uses 47xx.

## Layout

- Compose project **`gigpilot`**: `db`, `migrate` (one-shot), `web`, `app`, `worker`, `edge` — `ops/gx10-01/compose.yml`.
- **`edge`** (Caddy, host networking) binds only the Tailscale IPv4 on 4710/4711 and proxies to the loopback ports. It overwrites `X-Forwarded-For` with the real tailnet peer address (no trusted proxies), so per-IP auth rate limits cannot be spoofed, and never buffers the SSE stream. If Tailscale is not up at boot the bind fails and Docker's restart policy retries until it is.
- The apps connect to Postgres as **`gigpilot_app`** (non-superuser: data access on app tables, owner of the pg-boss schema only). Migrations run as the owner role `gigpilot`. `sql/app-role.sql` is applied idempotently by every deploy.
- Image: `gigpilot:<sha12>[-dirty]-<ts>` built from `ops/docker/Dockerfile` (one image, role chosen by command).
- Runtime dir `/srv/projects/gigpilot` (0700): `secrets/` (generated, never committed), `config/gigpilot.env` (non-secret), `backups/`, `notes/` (releases/backups logs), `status/agentos.json` (worker snapshot for AgentOS), `release.env` (current image tag).
- External volumes `gigpilot_pgdata`, `gigpilot_storage` (a `down -v` cannot delete data).
- Networks: `gigpilot_internal` (db) and external `gx_gateway` (worker/app reach GX at `http://gx-litellm:4000/v1`).
- systemd **user** unit (linger is enabled): `gigpilot-backup.timer` (03:05 nightly, before gx-backup's 03:30 restic snapshot). (The earlier socat `gigpilot-ts-proxy@` units were replaced by the `edge` service; deploy/install disable them.)

Containers: `restart: unless-stopped`, health checks on every service, read-only root FS,
`cap_drop: ALL`, `no-new-privileges`, uid 10001, memory/cpu/pids limits, json-file logs 10m×5.

## Operations

```bash
ops/gx10-01/scripts/install-host.sh      # idempotent host setup (dirs, secrets, config, units)
ops/gx10-01/scripts/deploy.sh            # build + migrate + up --wait + smoke + auto-rollback
SKIP_BUILD=1 GIGPILOT_TAG=gigpilot:<tag> ops/gx10-01/scripts/deploy.sh   # redeploy an existing image
docker compose -p gigpilot -f ops/gx10-01/compose.yml --env-file /srv/projects/gigpilot/release.env ps
docker compose -p gigpilot -f ops/gx10-01/compose.yml --env-file /srv/projects/gigpilot/release.env logs -f worker
ops/gx10-01/scripts/backup.sh            # manual backup (db dump + storage tarball)
ops/gx10-01/scripts/restore.sh <dump> --yes-replace-database
ops/gx10-01/scripts/purge-test-accounts.sh [--yes]   # remove example.com / gigpilot.dev test accounts
curl -s http://127.0.0.1:4712/readyz
```

Supervision API (for AgentOS / Odin / ops tooling; token in `secrets/agentos_supervision_token`):

```bash
T=$(cat /srv/projects/gigpilot/secrets/agentos_supervision_token)
curl -s -H "Authorization: Bearer $T" http://127.0.0.1:4712/api/supervision/status
curl -s -X POST -H "Authorization: Bearer $T" -H "Idempotency-Key: $(uuidgen)" \
  http://127.0.0.1:4712/api/supervision/trigger/source-refresh-all
```

## Shared-host rules

Only touch Docker resources prefixed `gigpilot`. Never `docker system prune`, never restart
the Docker daemon, never bind `0.0.0.0` on the host. Never use `gx-max` from GigPilot, and keep
GigPilot to one concurrent gx-code request (`GX_CODE_MAX_CONCURRENCY=1`): gx-code has one slot per
node and is shared with AgentOS.

## Secrets & credentials

Generated secrets live in `/srv/projects/gigpilot/secrets` (files are 0644 because compose
bind-mounts them into uid-10001 containers; the directory is 0700 so other host users cannot
read them). Provider API keys can be added either as tenant credentials in the dashboard
(Integrations → encrypted with `encryption_key`) or as secret files + env for server-wide use.
Paid providers remain disabled until `PAID_PROVIDER_DAILY_BUDGET_USD` > 0 **and** the workspace's
daily paid spend limit > 0.
