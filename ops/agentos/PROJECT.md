# GigPilot

```
Name: GigPilot
Slug: gigpilot
Type: software
Outcome: An agentic opportunity-to-delivery OS. It researches markets and sources
  permitted opportunities. It prices them deterministically and drafts proposals for
  owner approval. After approval it plans, runs, QA-checks and packages the work.
  "Find profitable work. Win it. Get it done." (repository AGENTS.md)
Context folder: projects/gigpilot/
Buzz channel(s): #gigpilot (id b79f3679-2bf2-4667-b53a-d386f7370e23)
Kanban board: gigpilot
GitHub repo: https://github.com/legenex/gigpilot (public)
Local repo path: /home/legenex/Documents/Projects/GigPilot (gx10-01 source checkout)
Runtime data: /srv/projects/gigpilot (secrets, releases, status — not git)
AGENTS.md: present at repo root. Canonical engineering contract.
Primary profiles: Bossman, Archie, Dexter, Bugsy, Critic
Control tower: Archie
Approval owner: Nick (human-only gates in AGENTS.md)
Source of truth: repository / GitHub
Current status: Internal V1 shipped 2026-09-27. AgentOS / AI OS / Buzz integration
  authorized 2026-10-04 (supersedes D7 deferral).
```

## Runtime (gx10-01)

- Docker Compose project `gigpilot`. Ports are published on loopback and exposed on the
  tailnet through the Caddy `edge` service (Tailscale IP only).
- Ports: 4710 web, 4711 app, 4712 worker health and supervision (loopback only), 4715
  Postgres (loopback). The dev servers use 4720–4722.
- Runtime data lives in `/srv/projects/gigpilot` (`secrets/`, `config/`, `backups/`,
  `status/`, `releases/`). The Docker volumes are `gigpilot_pgdata` and `gigpilot_storage`.
- Local inference goes to GX10 through the LiteLLM gateway, using the virtual key alias
  `gigpilot`. Live-verified 2026-10-04: `gx-mini`, `gx-code`, `gx-auto`. Never `gx-max`.

## How AgentOS supervises GigPilot

Software work is claimed by the GX10 executor from the `gigpilot` Kanban board
(lane `gx10`). Product runtime supervision remains pull-only: the worker writes
`/srv/projects/gigpilot/status/agentos.json` and serves a bearer-token API on
`127.0.0.1:4712`. `README.md` in this folder has the details.

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
- changing GitHub repository visibility
