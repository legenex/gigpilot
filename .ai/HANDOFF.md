# Handoff — read this first

**What GigPilot is:** agentic opportunity-to-delivery OS (see AGENTS.md).
**Where things run:** gx10-01 (Tailscale 100.105.214.61). Prod ports 4710 web, 4711 app,
4712 worker health (loopback), 4715 postgres (loopback). Dev ports 4720/4721/4722.
Runtime dir `/srv/projects/gigpilot` (secrets/, config/, backups/, status/).

**Current phase:** Milestone 2–4 in parallel (worker/agents, dashboard, marketing site).
See BACKLOG.md for owners and PROGRESS.md for the log.

**Next action:** integrate specialist output, build Docker image + compose stack,
run E2E demo flow, run independent reviews.

## Completion contract (from the build brief)
Repository clean + pushed, no secrets · premium responsive animated site with
correct Log in/Sign up ↔ Go to Dashboard · dashboard pages (Command Center,
Radar, Market Lab, Applications, Jobs, Production, Agents, Costs, Integrations,
Settings) behind auth · durable orchestrator, specialist agents, worker,
scheduled sourcing, repair loop, independent QA, event log · Factory/GX/Grok/
Kie/Higgsfield adapters with fallback and graceful missing-credential states ·
deterministic economics with configurable 50% / $300 / $300 rules · no
prohibited scraping/auto-apply · production build running on gx10-01 via
Tailscale, restart policy, health checks, persistent DB · typecheck, lint,
tests, browser smoke, E2E demo flow, engineering/design/security reviews.
