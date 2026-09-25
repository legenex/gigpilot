# GigPilot — instructions for coding agents

GigPilot is an **agentic opportunity-to-delivery operating system**: it
researches markets, sources permitted opportunities, analyses and prices them
deterministically, drafts proposals, and — after owner approval — plans,
executes, QA-checks, repairs and packages the work. Promise: *Find profitable
work. Win it. Get it done.*

This file is the canonical engineering contract. `CLAUDE.md` only points here.
Live project state lives in `.ai/` (PLAN, BACKLOG, PROGRESS, DECISIONS,
BLOCKERS, EVIDENCE, HANDOFF) — read `.ai/HANDOFF.md` first.

## Autonomy

This project inherits the standing authority of the Legenex AgentOS policy:
safe, reversible, internal work proceeds without asking. Do not ask for
approval for libraries, refactors, schema migrations (this is a young local
project), ports inside the GigPilot range, tests, restarts of GigPilot
services, commits or pushes to `legenex/gigpilot`.

**Human-only gates** (never automate around them): OAuth/MFA logins,
entering or rotating real credentials, enabling real-money spend (raising
`PAID_PROVIDER_DAILY_BUDGET_USD` or tenant `dailyPaidSpendLimitUsd` above 0),
sending anything to real clients/prospects, marketplace submissions (always
behind owner approval), pricing/legal commitments, DNS changes, and
destructive actions on production data.

## Repository map

```
apps/web            Next.js 16 marketing site (gigpilot.ai)            :4710 prod / :4720 dev
apps/app            Next.js 16 dashboard + auth API (app.gigpilot.ai) :4711 prod / :4721 dev
services/worker     pg-boss worker, scheduler, orchestrator, health    :4712 prod / :4722 dev
packages/config     env schema (zod), BUSINESS_DEFAULTS, service families, fee defaults, ports
packages/contracts  state machines, tenant settings schema, analysis/QA schemas, provider/source interfaces, queue names, integration registry
packages/db         drizzle schema + migrations, client, audited transitions, events, queue (pg-boss), tenancy, secrets (AES-GCM), demo seed
packages/auth       Better Auth (email+password, cross-subdomain cookies), session context, workspace bootstrap hook
packages/economics  deterministic calculator, gates/scoring, price catalog, creative route choice, dedupe/matching/expiry rules
packages/agents     owner commands (application service layer), agent implementations, orchestrator/workflow engine
packages/providers  IntelligenceProvider + ModelRouter (factory, gx, grok, mock), CreativeProviderBroker (kie, higgsfield, mock), source adapters, AgentOS adapter, storage
packages/ui         design tokens (theme.css), fonts, shared components
ops/gx10-01         compose stack, Tailscale proxy unit, deploy/backup scripts, runbook
ops/vps             future public deployment (Caddy HTTPS, domains)
docs/               ARCHITECTURE, DESIGN, RUNBOOK, research/
e2e/                Playwright end-to-end tests
```

## Commands

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test      # must pass before every commit
pnpm e2e                                       # Playwright against a running stack
pnpm db:generate                               # after editing packages/db/src/schema.ts
pnpm db:migrate                                # applies migrations (DATABASE_URL)
pnpm dev:app / dev:web / dev:worker            # local dev on 4721 / 4720 / 4722
ops/gx10-01/scripts/deploy.sh                  # build + deploy the persistent stack
pnpm secrets:scan                              # gitleaks before pushing (repo is PUBLIC)
```

Local dev uses the gitignored root `.env` (generated from
`/srv/projects/gigpilot/secrets`). Never run `next build` with
`NODE_ENV=development`.

## Non-negotiable engineering rules

1. **Economics are deterministic.** LLMs estimate quantities/attempts only.
   All money comes from `@gigpilot/economics` + the price catalog. Unknown
   price → estimate marked incomplete, never invented.
2. **Thresholds are configuration.** Read margin/profit/budget thresholds,
   limits and autonomy from tenant settings (`getTenantSettings`), never
   literals. Defaults live only in `packages/config/src/defaults.ts`.
3. **Every status change goes through `transition()`** (validated against
   `packages/contracts/src/states.ts`, audited). Never `update ... set status`
   directly. Failed attempts are never overwritten — retries create new
   `agent_run` rows and increment `attempts`.
4. **Side effects are idempotent.** Submissions, client messages and paid
   generations carry idempotency keys (unique indexes enforce it).
5. **Spend guardrails.** Paid providers are called only when both the env
   budget and the tenant daily budget are > 0 and the job's spend limit
   allows it. Default is mock/test mode. Every paid workflow has estimated
   spend, max authorised spend, attempt limit and repair limit.
6. **Marketplace compliance.** No scraping, no browser automation of
   marketplaces, no CAPTCHA/auth/rate-limit bypass. Respect each adapter's
   `SourceCapabilities` (`backgroundPollingAllowed`, `minPollIntervalMinutes`,
   `maxCacheTtlHours`, `canSubmit`). See `docs/research/marketplaces.md`.
7. **Providers sit behind adapters.** Core logic never imports a vendor SDK.
   Missing credentials → `needs_configuration` + mock mode, never a crash.
8. **Tenant isolation.** Every query filters by `tenantId` from the session
   context. Private assets are served only through authenticated routes.
9. **Secrets.** Never print, log, commit or return secret values. The repo is
   public. Tenant credentials are AES-256-GCM encrypted (`packages/db/src/secrets.ts`).
10. **No chain-of-thought in the UI.** Show concise rationale and evidence.

## Shared-host rules (gx10-01)

Only touch Docker resources prefixed `gigpilot`. Never prune, never restart
the Docker daemon, never bind `0.0.0.0`. Containers publish on `127.0.0.1`;
Tailscale exposure is the `gigpilot-ts-proxy` user unit. GigPilot uses only
ports 4710–4729. Do not use `gx-max`. Runtime data lives in
`/srv/projects/gigpilot` and external volumes `gigpilot_pgdata`,
`gigpilot_storage`.

## Git

Commit logical milestones with plain imperative messages that say what
changed and why (no conventional-commit prefixes). Run `pnpm check` and
`pnpm secrets:scan` first. Push to `main`; never force-push.
