# GigPilot

```
Name: GigPilot
Slug: gigpilot
Type: software
Outcome: An agentic opportunity-to-delivery OS. It researches markets and sources
  permitted opportunities. It prices them deterministically and drafts proposals for
  owner approval. After approval it plans, runs, QA-checks and packages the work.
  "Find profitable work. Win it. Get it done." (repository AGENTS.md)
Context folder: projects/gigpilot/ (created on import)
Buzz channel(s): UNCONFIRMED (none exists)
Kanban board: UNCONFIRMED (none exists; import would create it)
GitHub repo: https://github.com/legenex/gigpilot (public), from the gx10-01 checkout's remote
Local repo path: /home/legenex/Documents/Projects/GigSmith (gx10-01)
AGENTS.md: present at repo root. It is the canonical engineering contract.
Primary profiles: UNCONFIRMED (the expected software lifecycle is Bossman → Archie → Dexter → Bugsy → Critic)
Control tower: UNCONFIRMED (archie by convention)
Approval owner: UNCONFIRMED
Source of truth: repository
Current status: Active greenfield build (see .ai/HANDOFF.md). NOT registered in AgentOS (D7).
```

## Runtime (gx10-01)

- Docker Compose project `gigpilot`. Ports are published on loopback and exposed on the
  tailnet through the `gigpilot-ts-proxy` user unit.
- Ports: 4710 web, 4711 app, 4712 worker health and supervision (loopback only), 4715
  Postgres (loopback). The dev servers use 4720–4722.
- Runtime data lives in `/srv/projects/gigpilot` (`secrets/`, `config/`, `backups/`,
  `status/`). The Docker volumes are `gigpilot_pgdata` and `gigpilot_storage`.
- Local inference goes to GX10 through the LiteLLM gateway, using the virtual key alias
  `gigpilot` and the models gx-mini, gx-code and gx-auto. gx-max is never used.

## How AgentOS supervises GigPilot

Supervision is pull-only. The worker writes a status snapshot to
`/srv/projects/gigpilot/status/agentos.json` and serves a bearer-token
supervision API on `127.0.0.1:4712`:

- `/healthz`
- `/readyz`
- `/api/supervision/status`
- `/api/supervision/pending`
- `POST /api/supervision/trigger/<allowlisted>` (needs an `Idempotency-Key`)

`README.md` in this folder has the details.

## Human-only gates (from AGENTS.md)

These are never automated:

- OAuth and MFA logins
- entering or rotating real credentials
- enabling real-money spend
- sending anything to real clients or prospects
- marketplace submissions (always behind owner approval)
- pricing and legal commitments
- DNS changes
- destructive actions on production data

## Notes

- AgentOS isn't registered on purpose (D7): importing would create Hermes Kanban work on
  this repo. The descriptor exists so that import can be a plain copy when the approval
  owner decides.
- Marketplace compliance is part of the adapters' `SourceCapabilities`. Upwork is
  user-directed search only, with no background polling and a 24 h cache. Freelancer
  bids go out only after owner approval. Contra and Fiverr come in only as forwarded
  emails or pasted text. Public feeds carry attribution and respect minimum poll
  intervals.
