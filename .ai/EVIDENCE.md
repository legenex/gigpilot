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
