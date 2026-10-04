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
- Deployed 9b716cb, 1435fe8: gated feature scaffolding to demo only; made demo code artifacts build
  on the deterministic skeleton (one labelled defect → clean repair); demo code/test QA is
  deterministic_only (labelled), live keeps model review.
- FINAL: 1435fe8 deployed and healthy. typecheck + lint + 402 tests + web/app/worker builds PASS.
  auth+smoke 9/9; required demo flow E2E PASS (19.6 min, 1 repair, delivered, zip + ledger + audit).
  Backup verified; non-destructive restore rehearsal PASS (36 tables, pg-boss restored, runtime role
  grants reapplied); worker restart reclaims work ~4 s; watchdog + timers active; Tailscale 4710/4711
  200; version endpoint = deployed SHA. Pushed to legenex/gigpilot.

## 2026-09-27 (operator handover)
- Forced a password choice on the operator's first login (507e4ba): `must_change_password` flag
  (additive migration 0003), `/set-password` page, 403-gated server actions and data APIs, change
  run through Better Auth's own in-process reset-token flow (no email transport, tokens never
  leave the server), other sessions revoked, flag cleared on success. Operator bootstrap script in
  packages/auth (password read from stdin, never logged or committed).
- Named the operator workspace at bootstrap and fixed its audit row (cf6ae67): rename applies
  whenever the run created the account; audit row keeps the user id in `data` (audit subject_id is
  uuid, Better Auth user ids are text).
- Bootstrapped the operator account: owner of the live "GigPilot" workspace, recognized via
  `OPERATOR_EMAILS` (added to an empty list), flag armed, 0 sessions, audit rows recorded. The
  one-time bootstrap password was delivered to the owner out-of-band; full-history grep + gitleaks
  clean — it appears nowhere in the repo, env files, docs, logs or image layers.
- Deployed cf6ae67 and verified: worker ready at schema 0003_must_change_password; an 11-step
  Playwright live first-login check passed (forced change, gated routes, 403 APIs, new password
  works, old rejected, account restored to bootstrap state afterwards without logging in);
  405 tests / 1 skipped; typecheck + lint for all touched packages; dashboard production build.
  Pushed; local HEAD = origin/main = deployed SHA.
- Post-ship health check (~15:53 SAST): host rebooted at 15:51 — all 5 containers self-recovered
  healthy via `unless-stopped` + linger, /login 200, app health OK (db 1 ms), worker readyz OK
  with fresh schedules. Real reboot persistence confirmed (previously only verified by
  prerequisites).

## 2026-10-04 (AI OS / AgentOS / Buzz integration)
- Verified source checkout `/home/legenex/Documents/Projects/GigPilot` on `main`
  at `cf6ae67`; runtime data remains `/srv/projects/gigpilot`. Retired path
  `GigSmith` is not the coding tree.
- `ai mcp` on gx10-01 works with the machine token (tools: use_context,
  search_context, read_context, create_project). Canonical priorities query
  returned `company/CURRENT_PRIORITIES.md` (GigPilot is NOW).
- Created Buzz `#gigpilot` (`b79f3679-2bf2-4667-b53a-d386f7370e23`); members
  Bossman+Nick owners, Archie/Dexter/Bugsy/Critic members.
- D7 registration deferral superseded (D19). Compose stack is down since
  2026-09-27 (watchdog alerting; db not running; backups failing). AI OS
  working-copy bind still needs owner portal `allowed_roots` (see BLOCKERS).
