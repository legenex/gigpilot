# GigPilot

**Find profitable work. Win it. Get it done.**

GigPilot is an agentic opportunity-to-delivery operating system. It researches markets,
sources opportunities through permitted channels, understands each brief, prices it with a
deterministic economics engine, recommends what to pursue, drafts proposals for owner
approval, and — once work is won — plans, executes, QA-checks, repairs and packages the
delivery with a team of specialist AI agents. The owner decides three things: which
opportunities to pursue, what to commit to commercially, and what gets delivered.

- Marketing site: `gigpilot.ai` · Dashboard: `app.gigpilot.ai`
- Internal V1 runs on **gx10-01** over Tailscale — see [`ops/gx10-01/README.md`](ops/gx10-01/README.md)

| | Local (Tailscale) |
|---|---|
| Website | http://100.105.214.61:4710 |
| Dashboard | http://100.105.214.61:4711 |

## Repository

```
apps/web          marketing site (Next.js 16)
apps/app          dashboard + auth API (Next.js 16)
services/worker   durable worker: agents, orchestrator, schedules, supervision API
packages/*        config · contracts · db · auth · economics · agents · providers · ui
ops/gx10-01       compose stack, Tailscale proxy units, deploy/backup scripts
ops/vps           future public deployment (Caddy HTTPS, cross-subdomain auth)
docs/             ARCHITECTURE · DESIGN · RUNBOOK · research/
e2e/              Playwright end-to-end tests
.ai/              persistent build state (plan, progress, decisions, evidence, handoff)
```

Start with [`AGENTS.md`](AGENTS.md) (engineering contract) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Development

```bash
pnpm install
# root .env is generated from /srv/projects/gigpilot/secrets (see .env.example)
pnpm db:migrate
pnpm dev:app      # http://localhost:4721
pnpm dev:web      # http://localhost:4720
pnpm dev:worker   # worker + health on :4722
pnpm check        # typecheck + lint + unit/integration tests
pnpm e2e          # Playwright against the running stack
```

## Deployment (gx10-01)

```bash
ops/gx10-01/scripts/install-host.sh   # once: dirs, secrets, config, systemd user units
ops/gx10-01/scripts/deploy.sh         # build image, migrate, start, smoke-check, auto-rollback
```

## Principles

- **Deterministic economics** — models estimate quantities; a calculator computes cost,
  fees, contingency, shadow cost, profit, margin and break-even. Missing prices are flagged,
  never invented. Default gates (50% margin, $300 profit, $300 budget) are settings.
- **Compliance first** — no scraping, no anti-bot bypass, submission only where a
  marketplace officially permits it, always after owner approval.
- **Spend safety** — paid providers stay off until budgets are explicitly configured; every
  paid workflow has estimated spend, a hard limit, and attempt/repair caps.
- **Everything auditable** — explicit state machines, audited transitions, append-only
  agent runs and events.
