# GigPilot architecture

## System shape

```
                    ┌──────────────── gx10-01 (Tailscale 100.105.214.61) ────────────────┐
 browser ─▶ Caddy edge (Tailscale IP :4710/:4711, rewrites X-Forwarded-For)          │
            :4710 ▶ │ web  (Next.js, marketing)  ── validates session cookie ──┐          │
            :4711 ▶ │ app  (Next.js, dashboard + Better Auth + SSE + assets) ──┤          │
                    │                               commands ─▶ pg-boss queues │          │
                    │ worker (pg-boss handlers + cron schedules + health :4712)│          │
                    │   ├─ agents: scout · analyst · economics · proposal ·    ▼          │
                    │   │  planner · orchestrator · creative/coder/copy/...  PostgreSQL 17│
                    │   │  · QA · recovery · client · market research      (app data + │
                    │   ├─ ModelRouter ─▶ GX (LiteLLM gx-litellm:4000) | Factory | Grok │
                    │   ├─ CreativeBroker ─▶ Kie | Higgsfield | mock        pg-boss)   │
                    │   ├─ Source adapters ─▶ Freelancer API | Upwork (user-directed) | │
                    │   │  feeds | inbound email/webhook | manual | demo marketplace    │
                    │   └─ Storage (filesystem volume; S3/R2 adapter)                   │
                    │ AgentOS: pull-only supervision API + status file                  │
                    └────────────────────────────────────────────────────────────────────┘

Source checkout (git): `/home/legenex/Documents/Projects/GigPilot`.
Runtime data (not git): `/srv/projects/gigpilot`. Hermes VPS is AgentOS
control plane only — software execution is the gx10-01 lane.
```

- **One Postgres** holds application data, Better Auth tables, and the pg-boss queue
  schema. No Redis: background work is durable across restarts.
- **Web** and **app** are separate Next.js 16 apps sharing packages. The marketing site
  reads the same session (shared secret + DB), so CTA state is rendered server-side.
- **Worker** is the only process that talks to model/creative/marketplace providers
  (the app only runs zero-cost connection tests).
- **Edge**: a Caddy container on host networking binds only the Tailscale IP and proxies to
  the loopback-published containers; it overwrites `X-Forwarded-For`, so per-IP auth limits
  are trustworthy. Containers never publish on the Tailscale or LAN addresses directly.
- **Database roles**: migrations run as the owner role; web/app/worker connect as the
  non-superuser `gigpilot_app` (data access on app tables, owner of the pg-boss schema only,
  statement/lock/idle-transaction timeouts).

## Packages

| Package | Responsibility |
|---|---|
| `config` | Env schema (zod, lazy), `BUSINESS_DEFAULTS` (the only place defaults live), service families, platform-fee defaults, ports |
| `contracts` | State machines + `assertTransition`, tenant settings schema, analysis/proposal/QA/market-insight schemas, provider/source/creative interfaces, queue names & payloads, agent roster, integration registry |
| `db` | Drizzle schema (30 tables) + migrations, singleton client, `transition()` (validated, audited, optimistic), `emitEvent()` (+ `pg_notify`), pg-boss queue config/producer, tenancy bootstrap, AES-GCM tenant secrets, demo history seeder |
| `auth` | Better Auth (email+password, scrypt, DB rate limit, cookie prefix `gigpilot`, cross-subdomain cookies via env), `getSessionContext`, `isSignedIn`, workspace-created hook |
| `economics` | Deterministic calculator (price basis, line items, fees with minimums, revision contingency, contingency, shadow cost, profit, margin, break-even), gates + scoring, price catalog (verified date), creative route choice by cost per usable asset, dedupe/matching/expiry/budget-triage rules |
| `providers` | `IntelligenceRouter` (task-based routing, budget & family gating, fallback chain), `CreativeBroker`, vendor adapters, source adapters with compliance capabilities, storage, AgentOS adapter, zero-cost health checks |
| `agents` | Owner commands (application service layer), agent runtime (agent_run lifecycle, ledger, spend enforcement), agent implementations, workflow engine |
| `ui` | Tokens (`theme.css`), fonts, shared components |

## Core flows

**Sourcing → recommendation.** Scheduler fans out `source-refresh` per tenant × enabled
source (respecting `backgroundPollingAllowed` / `minPollIntervalMinutes`; demo sourcing only
for workspaces active in the last 7 days; per-market allocation weights the batch). Scout
normalises, matches a service family, dedupes (hash + shingle/token Jaccard) and inserts.
**Two-tier analysis:** every brief is triaged instantly by a deterministic analyser and
priced by the economics engine (so the radar fills immediately), but triage alone never
recommends "pursue". The best candidates (capped per tenant per hour) are refined by the
model router (local GX first) on a dedicated single-slot queue; only a successful
refinement promotes a brief to "pursue" and the shortlist. Economics prices quantities
with the routes that will actually run, scores gates (profit ≥ min, margin ≥ min hard;
budget soft; fit/confidence configurable; incomplete never "pursue").

**Pursuit → commitment.** Owner approves pursuit → Proposal Agent drafts (specific scope,
price rule, assumptions, questions) → owner approves proposal/price/scope (commercial gate)
→ application `approved` → submit handler: official API submission only where permitted
(Freelancer; demo marketplace), otherwise *manual submission required* notification.

**Award → delivery.** Won application → job + client (idempotent per application) →
Production Planner builds a DAG → orchestrator ticks ready steps → execution agents produce
real assets (stored, hashed) with generation/ledger records → independent QA (different
provider/model where possible; deterministic checks + model review) → Recovery chooses
repair/regenerate/reroute within attempt/repair/spend limits → re-QA → delivery package
(zip + manifest + notes) → **owner approves final delivery** → delivered → closed.

## State & audit

Every status change goes through `transition()` → validated against the machine in
`contracts/states.ts`, applied with optimistic concurrency, recorded in `audit_event`, and
optionally streamed to `agent_event` (live activity). Retries create new `agent_run` rows;
failed runs, generations and QA reviews are never overwritten.

## Shared local inference

gx-code has one llama.cpp slot per node (two cluster-wide) and is shared with AgentOS, so
GigPilot uses at most one concurrent heavy request (`GX_CODE_MAX_CONCURRENCY`), served by
priority: production/QA/recovery → market research → background refinement. A router
circuit breaker opens after consecutive GX failures; per-tenant daily heavy-call quotas
and refinement caps protect the cluster from sign-up floods.

## Safety

- Paid providers require `PAID_PROVIDER_DAILY_BUDGET_USD` > 0 **and** tenant
  `dailyPaidSpendLimitUsd` > 0 (clamped to an operator ceiling) and remaining daily/job
  budget, reserved under a lock before each paid call; defaults are 0 (mock mode).
- Server-wide provider credentials are available only to operator workspaces
  (`OPERATOR_EMAILS`); everyone else stores encrypted, AAD-bound per-workspace keys.
- Per-job spend limit, max step attempts, max repairs per job, max generations per step.
- Idempotency keys + unique indexes on applications, generations, notifications, and the
  `idempotency_key` table for side effects.
- Marketplace compliance encoded in `SourceCapabilities` (see `docs/research/marketplaces.md`).
- Tenant isolation: every query filters by the session's tenant; assets served only via
  authenticated, tenant-checked routes.

## Observability

Structured JSON logs (pino in the worker), `agent_run` + `agent_event` + `audit_event`
history, provider health rows, health endpoints (`/api/health` on web/app, `/healthz` +
`/readyz` on the worker — readiness checks DB, queue, migrations, schedule freshness),
token-protected supervision API + status snapshot for AgentOS, a host watchdog that
restarts unhealthy containers and writes `status/alerts.log`.
