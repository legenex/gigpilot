# Handoff — read this first

**What GigPilot is:** agentic opportunity-to-delivery OS (see AGENTS.md).
**Live (tailnet):** http://100.105.214.61:4710 (site) · http://100.105.214.61:4711 (dashboard).
Worker health/supervision 127.0.0.1:4712 · Postgres 127.0.0.1:4715. Runtime dir /srv/projects/gigpilot.
Deploy: `ops/gx10-01/scripts/deploy.sh` (builds, backs up, migrates, waits, smoke-tests, rolls back).

**State (2026-09-26 ~22:40 SAST):** stack deployed at 2796d73 and healthy; required E2E demo flow
passes; security + engineering review findings repaired; product + design reviews FAILED and a
second repair wave (backend integrity / dashboard / website) is in progress; ops review running.

**Next action:** integrate repair wave 2 → typecheck/lint/tests/build → deploy → purge test accounts
(`ops/gx10-01/scripts/purge-test-accounts.sh --yes`) → re-run full E2E → re-review (product, design)
→ final report.

## Completion contract (from the build brief)
Repository clean + pushed, no secrets · premium responsive animated site with correct Log in/Sign up ↔
Go to Dashboard · dashboard pages behind auth · durable orchestrator, specialist agents, worker,
scheduled sourcing, repair loop, independent QA, event log · Factory/GX/Grok/Kie/Higgsfield adapters
with fallback and graceful missing-credential states · deterministic economics with configurable
50%/$300/$300 · no prohibited scraping/auto-apply · production build running on gx10-01 via Tailscale,
restart policy, health checks, persistent DB · typecheck, lint, tests, browser smoke, E2E demo flow,
engineering/design/security reviews.
