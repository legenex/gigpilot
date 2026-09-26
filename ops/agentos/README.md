# GigPilot ↔ AgentOS

GigPilot is **ready to import** into Legenex AgentOS but is **not registered**
(decision D7 in `.ai/DECISIONS.md`): importing the descriptor makes the Hermes
project factory create a board and start work on this repository, so it
waits for the approval owner.

| File | Purpose |
|---|---|
| `project.yaml` | Machine-readable AgentOS descriptor (schema_version 1). Unknowns are `UNCONFIRMED`. |
| `PROJECT.md` | Human-readable companion, same facts. |
| `README.md` | This file: how AgentOS supervises GigPilot. |

To import later, copy this folder to AgentOS as `projects/_inbox/gigpilot/`
(the inbox watcher runs `hermes-project-factory import`). Don't edit the AgentOS
repository from here.

## Supervision model

AgentOS has **no runtime supervision API today**: the control center is a
read-only dashboard and the supervisor has no job registry. GigPilot therefore
supervises its own work. Its durable orchestrator runs on pg-boss/Postgres
inside the worker. AgentOS can observe that work in two ways, and both are
**pull-only**:

1. **Status snapshot file:** the worker's AgentOS adapter
   (`packages/providers/src/agentos`) writes
   `/srv/projects/gigpilot/status/agentos.json`. It writes a temporary file and
   renames it, so a reader never sees half-written JSON. Error messages in the
   snapshot are redacted.
2. **Supervision HTTP API:** the worker serves this API on loopback at
   `127.0.0.1:4712`. It isn't exposed to the tailnet or to the internet.

A third mode is an HTTP push from GigPilot to AgentOS. It's a future
**adapter boundary** and is off by default. It only turns on when
`AGENTOS_PUSH_ENABLED=1` and `AGENTOS_BASE_URL` are both set. The target path
`/api/projects/gigpilot/status` is **UNCONFIRMED** because AgentOS has no such
endpoint yet.

### Supervision API (worker, `127.0.0.1:4712`)

All `/api/supervision/*` routes need
`Authorization: Bearer $AGENTOS_SUPERVISION_TOKEN`. When the token is unset,
those routes are disabled and return 503. They never return 200 without a
token. Responses are JSON and contain no secrets, no chain-of-thought and no
client PII beyond counts.

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/healthz` | none | Liveness only: the process is up. Docker healthcheck. |
| GET | `/readyz` | none | Readiness: database reachable, queue started, migrations applied. Returns 503 while not ready. |
| GET | `/api/supervision/status` | bearer | The same `AgentOSStatusSnapshot` as the file: `service`, `version`, `generatedAt`, `health` (`ok`/`degraded`/`down`), per-queue `queued/active/failed`, `pending` counts, `lastErrors` (redacted). |
| GET | `/api/supervision/pending` | bearer | Items waiting on a human: approvals (proposals and submissions), jobs awaiting final approval, and failed steps from the last 24 h. Each item has an id, kind, age and short summary. |
| POST | `/api/supervision/trigger/<name>` | bearer + `Idempotency-Key` | Enqueues one **allowlisted** maintenance job. Returns `202 {jobId}`. A repeated `Idempotency-Key` returns the original result and doesn't enqueue again. Unknown names return 404. A missing key returns 400. |

The trigger allowlist lives in the worker, so the worker owns the exact set.
It is limited to safe, reversible, internal jobs, for example `health-sweep`,
`source-sync` (still bound by each source's `SourceCapabilities` and
minimum intervals), `metrics-rollup` and `expire-stale`. **No trigger can**
submit to a marketplace, message a client, approve anything, raise a spend
limit or touch credentials. Those actions are human-only gates, listed in
`AGENTS.md`.

Example (from gx10-01 only):

```bash
curl -s -H "Authorization: Bearer $AGENTOS_SUPERVISION_TOKEN" http://127.0.0.1:4712/api/supervision/status
curl -s -X POST -H "Authorization: Bearer $AGENTOS_SUPERVISION_TOKEN" \
     -H "Idempotency-Key: $(uuidgen)" http://127.0.0.1:4712/api/supervision/trigger/health-sweep
```

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `AGENTOS_SUPERVISION_TOKEN` | unset | Bearer token for `/api/supervision/*`. Unset disables those routes. It's a secret, so it's never logged. |
| `AGENTOS_STATUS_FILE` | `/srv/projects/gigpilot/status/agentos.json` when that directory exists and is writable | Where the snapshot is written. With no writable location the adapter falls back to `noop` mode. |
| `AGENTOS_BASE_URL` | unset | Future push target. It's ignored unless `AGENTOS_PUSH_ENABLED=1`. |
| `AGENTOS_PUSH_ENABLED` | off | Turns on the experimental HTTP push adapter. |
| `AGENTOS_PUSH_TOKEN` | unset | Bearer token for the push target (**UNCONFIRMED**: AgentOS hasn't defined one). |

The Integrations page, through `checkIntegration("agentos")`, reports the
adapter mode, the last publish time and the last write error.
