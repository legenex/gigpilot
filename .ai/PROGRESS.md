# Progress log

## 2026-09-26
- Inspected gx10-01: Ubuntu 24.04 aarch64 (GB10, 121 GiB RAM), Docker 29 + Compose 5,
  Node 22.23 / pnpm 9.15, Tailscale IP 100.105.214.61, systemd user units with linger.
- Discovery: GX LiteLLM gateway (gx-mini/gx-code/gx-auto), AgentOS (no runtime
  supervision API), deploy conventions (FinancialOS pattern), free ports 4710–4729.
- Researched official docs: marketplaces (docs/research/marketplaces.md), providers
  (docs/research/providers.md), stack versions.
- Built foundation: config, contracts (+state machine tests), db schema (30 tables) +
  migration, pg-boss queue module, auth (Better Auth; sign-up + workspace bootstrap
  verified), economics (+tests: 32 passing), commands layer, design tokens, app skeletons
  (both `next build` OK).
- Minted scoped GX virtual key `gigpilot` (gx-mini/gx-code/gx-auto) — verified.
- Started gigpilot-db (postgres:17) on 127.0.0.1:4715 with external volume.
- Launched 4 parallel specialists: agent system (router/broker/mock/storage/agents/worker/demo
  seeder), integrations (GX/Factory/Grok/Kie/Higgsfield/marketplaces/health/AgentOS), dashboard
  (apps/app + packages/ui), marketing site (apps/web).
- Ops (orchestrator): single multi-role Dockerfile + entrypoint (secret files → env), full compose
  stack (db, migrate, web, app, worker) with hardening + health checks, `gigpilot-ts-proxy@4710/4711`
  user units (active, bound to 100.105.214.61), nightly backup timer, deploy.sh (lock, mem guard,
  backup, migrate, --wait, smoke, rollback), backup/restore scripts, install-host.sh (run: OK),
  runtime config `/srv/projects/gigpilot/config/gigpilot.env`, VPS compose + Caddyfile + runbook.
- Docs: README, docs/ARCHITECTURE.md, docs/RUNBOOK.md, ops/gx10-01/README.md.
- E2E: playwright.config.ts + e2e/{auth,demo-flow,smoke}.spec.ts against a data-testid contract
  sent to the dashboard specialist.
- Integrations specialist finished (158 tests; live GX 12/12 valid analyses); committed f0e45af with ops/docs/e2e.
- ~02:50 SAST: agent-system, dashboard and marketing specialists hit an API session limit
  (reset 05:50). Resumed all three at 19:52 SAST from their transcripts; work on disk intact.
- Marketing site finished and committed (a4c8d55). Agent system finished; fixed a submission deadlock,
  added budget-priority analysis and idle-workspace GX safeguards, un-ignored the storage module;
  committed 352701d. Remaining specialist: dashboard.
- Independent engineering review: FAIL (4 confirmed dead-ends + spend/durability gaps). Independent
  security review: FAIL (H1 operator-credential fallback; M1–M6). Two repair engineers fixed all
  findings (+ orchestrator fixes: unpriced production → incomplete, configurable fit/confidence,
  runtime paid-ceiling clamp, audit changed-paths). 363 tests pass (2 consecutive runs).
- Ops: Caddy edge (Tailscale IP, trustworthy XFF) replaced socat; least-privilege DB role
  gigpilot_app; least-privilege secret mounts. First deploy of the edge failed health (caddy file
  capability vs cap_drop ALL) → automatic rollback worked → fixed with cap_add NET_BIND_SERVICE →
  deployed 2e29627. Purged 9 test/audit accounts from prod.
- Live GX pipeline verified on a real coding job: QA fail (failing retry test) → Recovery regenerate →
  independent QA pass (gx-code) → delivery prepared.
- 2796d73: required demo flow E2E PASSES end-to-end on live stack (13.4 min, real local inference).- Restart/recovery tests passed (worker exit → auto-restart; Postgres restart → reconnect 10 s;
  full compose restart → healthy 30 s; auth+smoke 9/9 afterwards).
- Independent product review: FAIL (hollow code verification, QA ignoring critical findings, triage-
  only pursue, unlabelled sample data, duplicate batch assets, inert allocation, routes priced vs run).
- Independent design review: FAIL (dashboard mobile tables, desktop clipping, number contradictions,
  stream garble, focus rings, plumbing leaks, integrations card stack, brand chip mismatch). Site close.
- Repair wave 2 launched: backend integrity engineer, dashboard engineer, website engineer; ops review running.

## 2026-09-27 (finish run)
- Verified repair wave 2 on disk: typecheck + lint + 401 tests + prod builds pass. Committed 322bd3c.
- Deployed 322bd3c; then fixed two live demo blockers found by the required E2E: (1) refine jobs now
  score by expected profit (priority) and the purge deletes stale queued work, so a pursue appears
  reliably; (2) QA no longer treats "tests not executed" as a blocking major (no test runner exists),
  and the deterministic code generator attempts every requested feature. Committed 1eb0de7, 01fc921,
  cdd7edd.
- Deployed cdd7edd; required demo flow E2E PASSES on live (12.3 min: 3 QA fails, 3 repairs, delivery,
  ledger, audit history). Restore rehearsal + watchdog/timers verified.
- Mobile sample-data notice wraps correctly; committed.
