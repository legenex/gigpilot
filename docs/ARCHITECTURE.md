# GigPilot architecture

## System shape

```
                    ┌──────────────── gx10-01 (Tailscale 100.105.214.61) ────────────────┐
 browser ──:4710──▶ │ web  (Next.js, marketing)  ── validates session cookie ──┐          │
 browser ──:4711──▶ │ app  (Next.js, dashboard + Better Auth + SSE + assets) ──┤          │
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
```

- **One Postgres** holds application data, Better Auth tables, and the pg-boss queue
  schema. No Redis: background work is durable across restarts.
- **Web** and **app** are separate Next.js 16 apps sharing packages. The marketing site
  reads the same session (shared secret + DB), so CTA state is rendered server-side.
- **Worker** is the only process that talks to model/creative/marketplace providers
  (the app only runs zero-cost connection tests).

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
source (respecting `backgroundPollingAllowed` / `minPollIntervalMinutes`). Scout normalises,
matches a service family, dedupes (hash + shingle/token Jaccard) and inserts. Analyst
produces a schema-validated `OpportunityAnalysis` (GX locally; mock fallback). Economics
prices quantities from the catalog with tenant settings, scores gates (profit ≥ min, margin
≥ min hard; budget soft; incomplete never "pursue"), and shortlists pursue-worthy work.

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

## Safety

- Paid providers require `PAID_PROVIDER_DAILY_BUDGET_USD` > 0 **and** tenant
  `dailyPaidSpendLimitUsd` > 0 and remaining daily/job budget; defaults are 0 (mock mode).
- Per-job spend limit, max step attempts, max repairs per job, max generations per step.
- Idempotency keys + unique indexes on applications, generations, notifications, and the
  `idempotency_key` table for side effects.
- Marketplace compliance encoded in `SourceCapabilities` (see `docs/research/marketplaces.md`).
- Tenant isolation: every query filters by the session's tenant; assets served only via
  authenticated, tenant-checked routes.

## Observability

Structured JSON logs (pino in the worker), `agent_run` + `agent_event` + `audit_event`
history, provider health rows, health endpoints (`/api/health` on web/app, `/healthz` +
`/readyz` on the worker), supervision snapshot for AgentOS.
