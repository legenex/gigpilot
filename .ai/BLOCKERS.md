# Blockers (external only)

| Item | Why external | Current handling |
|---|---|---|
| Factory.ai | `droid` CLI not installed; no FACTORY_API_KEY on host | Adapter built; status "Needs configuration"; mock/GX fallback |
| xAI / Grok | No server API key (grok CLI uses Nick's OIDC login — not reusable) | Adapter built; "Needs configuration"; GX/mock fallback |
| Kie.ai | No API key | Adapter built; mock creative provider used |
| Higgsfield | No API key | Adapter built; mock creative provider used |
| Upwork | Needs approved API key / user OAuth; ToS limits (user-directed search, 24h cache, commercial use) | Adapter + manual paste flow; "Needs configuration" |
| Freelancer | Needs app approval / OAuth token | Adapter (sandbox-ready) built; "Needs configuration" |
| Contra / Fiverr | No public API; ToS forbid automation | Manual paste + forwarded-email ingestion |
| Real-money spend | Owner must set budgets | Defaults 0 → mock/test mode |
| DNS / public VPS | Human gate | ops/vps prepared, not deployed |
| AI OS working-copy row | Proven: machine token is valid only for `/api/agent/*`. `PUT /api/machines/gx10-01` and `POST /api/discovery/register` return 401 Invalid bearer token. `locations/report` refreshes existing rows only. Admin token or portal session cookie required. | Discovery report for `/home/legenex/Documents/Projects/GigPilot` upserted (200, count=1). Nick: https://ai.legenex.com/ui/machines → gx10-01 → add allowed root `/home/legenex/Documents/Projects` (keep default_root `/srv/projects`) → Save → Scan now → Discovery → Register that path onto `gigpilot`. Do not register `/srv/projects/gigpilot`. Then Projects → gigpilot should show gx10-01 working copy on `main`. |
| Compose stack restore | GX10-01 MemAvailable ~3 GiB; deploy.sh refuses below 6 GiB; Next.js+Postgres start would contend with loaded GX model workload | Watchdog alerting since 2026-09-27; db not on :4715; backups failing. Restore via `SKIP_BUILD=1 GIGPILOT_TAG=gigpilot:cf6ae673c937-20260927t131101z ops/gx10-01/scripts/deploy.sh` only when ≥6 GiB is free without unloading a protected model. |
