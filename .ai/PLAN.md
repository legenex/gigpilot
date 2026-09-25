# GigPilot build plan

Goal: internal V1 of GigPilot running persistently on gx10-01 over Tailscale,
synced to github.com/legenex/gigpilot, satisfying the Definition of Done in the
original build brief (see HANDOFF.md → "Completion contract").

## Milestones
1. **Foundation** — monorepo, config, contracts/state machines, DB schema +
   migrations, queue, auth, economics (+tests), design tokens, app skeletons. ✅
2. **Agent system** — providers (Factory/GX/Grok/mock intelligence; Kie/
   Higgsfield/mock creative; marketplace source adapters; AgentOS adapter;
   storage), agents (scout, analyst, economics, proposal, planner, execution,
   QA, recovery, client, market research), orchestrator/workflow engine,
   worker service with schedules + health, demo history seeder.
3. **Dashboard** — Command Center, Opportunity Radar + detail, Market Lab,
   Applications, Jobs, Production DAG, Agents, Costs, Integrations, Settings,
   auth pages, command palette, live event stream (SSE).
4. **Marketing site** — premium site with Pilot Core hero, narrative sections,
   auth-aware nav (Log in/Sign up ↔ Go to Dashboard, no flash).
5. **Ops** — Docker image, compose services (web/app/worker/db/migrate),
   Tailscale proxy unit, deploy/backup scripts, health checks, restart test,
   VPS config.
6. **Verification** — unit/integration tests, Playwright E2E (full demo flow),
   browser QA screenshots, design/security/engineering/ops reviews, repairs.
7. **Release** — final adversarial review loop, docs, push, final report.

## Execution model
Orchestrator (lead session) owns integration and verification; specialist
agents own disjoint directories (see BACKLOG.md owners). Evidence goes to
EVIDENCE.md. Nothing is "done" without a passing check.
