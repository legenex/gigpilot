# Handoff — read this first

**What GigPilot is:** agentic opportunity-to-delivery OS (see AGENTS.md).
**Live (tailnet):** http://100.105.214.61:4710 (site) · http://100.105.214.61:4711 (dashboard).
Worker health/supervision 127.0.0.1:4712 · Postgres 127.0.0.1:4715. Runtime dir /srv/projects/gigpilot.
Deploy: `ops/gx10-01/scripts/deploy.sh` (builds, backs up, migrates, waits, smoke-tests, rolls back).

**State (2026-09-27 ~08:20 SAST):** internal V1 shipped. Stack deployed at 1435fe8 and healthy on
gx10-01; required demo-flow E2E passes end-to-end on the live stack (19.6 min, 1 labelled repair →
delivery); typecheck, lint, 402 tests and all production builds pass; backup + non-destructive restore
rehearsal verified; worker restart reclaims work in ~4 s; marketing and dashboard respond over
Tailscale. External credentials (Factory, Grok, Kie, Higgsfield, Upwork, Freelancer) remain
"needs configuration" and are documented in BLOCKERS.md — not blockers.

**Next action:** none required. Optional external follow-ups: connect provider credentials, register
with AgentOS (`ops/agentos/`), and deploy to the public VPS (`ops/vps/`).

## Completion contract (from the build brief)
Repository clean + pushed, no secrets · premium responsive animated site with correct Log in/Sign up ↔
Go to Dashboard · dashboard pages behind auth · durable orchestrator, specialist agents, worker,
scheduled sourcing, repair loop, independent QA, event log · Factory/GX/Grok/Kie/Higgsfield adapters
with fallback and graceful missing-credential states · deterministic economics with configurable
50%/$300/$300 · no prohibited scraping/auto-apply · production build running on gx10-01 via Tailscale,
restart policy, health checks, persistent DB · typecheck, lint, tests, browser smoke, E2E demo flow,
engineering/design/security reviews.
