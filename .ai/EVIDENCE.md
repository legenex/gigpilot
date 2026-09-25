# Evidence

| Check | Result | Detail |
|---|---|---|
| Unit tests (economics, rules, state machines, settings) | PASS 32/32 | `pnpm test` 2026-09-26 |
| `next build` apps/web skeleton | PASS | |
| `next build` apps/app skeleton | PASS | |
| Auth sign-up via API | PASS | 200, `gigpilot.session_token` HttpOnly SameSite=Lax cookie; workspace bootstrap created 6 markets + 7 sources |
| GX gateway with gigpilot key | PASS | /v1/models 200; gx-mini chat returned `{"ok":true}` |
