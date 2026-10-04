# Evidence

| Check | Result | Detail |
|---|---|---|
| Unit tests (economics, rules, state machines, settings) | PASS 32/32 | `pnpm test` 2026-09-26 |
| `next build` apps/web skeleton | PASS | |
| `next build` apps/app skeleton | PASS | |
| Auth sign-up via API | PASS | 200, `gigpilot.session_token` HttpOnly SameSite=Lax cookie; workspace bootstrap created 6 markets + 7 sources |
| GX gateway with gigpilot key | PASS | /v1/models 200; gx-mini chat returned `{"ok":true}` |
| Provider adapter tests (integrations) | PASS 158 (+1 opt-in live) | mocked fetch/child_process; SSRF, cost parsing, error mapping |
| Live GX structured analysis | PASS 12/12 | gx-code 25–35 s typical, valid OpportunityAnalysis, zero repairs |
| Full vitest suite (2026-09-26 20:15) | PASS 246 / 1 skipped, 3 consecutive runs | incl. full mock pipeline + 6 family E2E + engine limits |
| Concurrency: double submission | PASS after fix | lock-order deadlock (claim vs completion) fixed in applications.ts |
| Worker against dev DB | PASS | 17 queues + schedules registered; /readyz 200; supervision 401/202/400/404 as designed; clean SIGTERM |
| Marketing site Lighthouse | desktop 100/100/100/100; mobile 95/100/100/100 | FCP 0.3 s, LCP 0.7 s, CLS 0 (desktop) |
| Marketing auth-state SSR | PASS | curl HTML logged-out → nav-login/nav-signup; logged-in → nav-dashboard; identical after hydration |
| Full vitest after repairs | PASS 363 / 1 skipped ×2 | 34 files |
| Live DB role separation | PASS | web/app/worker connect as gigpilot_app (non-superuser); DDL denied |
| Edge proxy + CSP live | PASS | Tailscale 4710/4711 via Caddy; CSP + X-Frame-Options DENY on dashboard |
| Deploy auto-rollback | PASS (exercised for real) | edge unhealthy → rolled back to previous image automatically |
| Live GX QA-fail→repair→pass loop | PASS | job 4f28682d…: 2 QA fails, regenerate repair, 2 QA passes, delivery prepared |
| E2E auth + smoke suites (live, post-repair) | PASS 9/9 | protected routes, API 401s, sign-up/logout/login, wrong password, SSR CTA both states, health, console-clean site, all pages render, no mobile overflow |
| **E2E required demo flow §35 (live)** | **PASS** (13.4 min) | logged-out nav → signup → Go to Dashboard → radar → gates pass → approve pursuit → proposal → approve → award → job → DAG → QA fail → repair → QA pass → final approval → zip download → ledger estimate+actual → agents/events history |
| Independent product review | FAIL → repairs in progress | hollow verification, triage-only pursue, unlabelled sample data, duplicate batches, inert allocation || Restart: worker process exit (SIGTERM to PID 1 in-container) | PASS | graceful shutdown → Docker auto-restart (RestartCount 1) → healthy in ~1 s |
| Restart: worker hard kill (docker kill) | PASS (by design) | Docker treats `docker kill` as a manual stop (no auto-restart); `docker start` → healthy; queued work completed; orphaned active job recovered by pg-boss expiry/retry |
| Restart: PostgreSQL restart under load | PASS | app + worker reconnected automatically within 10 s |
| Restart: full stack `compose restart` | PASS | all 5 services healthy in ~30 s; Tailscale edge 200; auth+smoke E2E 9/9 after restart |
| Reboot persistence prerequisites | VERIFIED (reboot not executed — shared host) | linger=yes; containers `restart: unless-stopped` incl. edge (retries until Tailscale IP exists); backup timer enabled; docker enabled |

## 2026-09-27 (finish run, deployed 1435fe8)
| Check | Result | Detail |
|---|---|---|
| Typecheck / lint / tests | PASS | 402 passed, 1 skipped; 38 files |
| Production builds | PASS | apps/web, apps/app, worker |
| E2E auth + smoke | PASS 9/9 | protected routes, SSR CTA, health, all pages render, no mobile overflow |
| E2E required demo flow (live) | PASS (19.6 min) | signup → radar → pursue → proposal → award → job → QA fail → repair → QA pass → approval → delivery zip → ledger → audit |
| Backup | PASS | pre-deploy dumps verified with `pg_restore --list` |
| Restore rehearsal | PASS (non-destructive) | restored into a disposable DB: 36 tables, 1799 pg-boss jobs, runtime role grants reapplied, then dropped |
| Worker restart | PASS | `docker restart` → ready in ~4 s; no stranded work |
| Watchdog + timers | PASS | gigpilot-backup.timer, gigpilot-watchdog.timer active; watchdog silent when healthy |
| Tailscale | PASS | 4710 site 200; 4711 dashboard 307→login, /api/health 200 |
| Deployed version | PASS | supervision status version = 1435fe80568b |

## AgentOS GX10 executor smoke (2026-10-04)
| Check | Result | Detail |
|---|---|---|
| GX10 executor worktree | PASS | task t_5912988a; host gx10-01; lane gigpilot |
