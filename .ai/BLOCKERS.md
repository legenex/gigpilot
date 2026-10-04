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
| AI OS working-copy row | Machine token cannot mutate `allowed_roots` or approve discovery; `ai register` needs a user API token | Project `gigpilot` exists in AI OS with no locations. Source path `/home/legenex/Documents/Projects/GigPilot` reported via `/api/agent/locations/report` (200) but did not bind. Needs owner portal: Machines → gx10-01 → add allowed root `/home/legenex/Documents/Projects` → Scan now → register that path. Do not register `/srv/projects/gigpilot`. |
