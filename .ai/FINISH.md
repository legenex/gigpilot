# Finish — shipped

Internal V1 shipped 2026-09-27. No unresolved implementation items.

Deployed: gx10-01 stack at `cf6ae67` (healthy). All gates green:
- monorepo typecheck PASS · lint PASS · 405 tests PASS (1 skipped) · web/app/worker production builds PASS
- live E2E: auth + smoke 9/9, required demo flow PASS (19.6 min, 1 labelled repair → delivery)
- backup verified · non-destructive restore rehearsal PASS (schema 36 tables, pg-boss jobs restored, runtime role grants reapplied)
- worker restart reclaims work in ~4 s · watchdog/timers active · Tailscale 4710/4711 respond · version endpoint reports the deployed SHA

## Repairs completed this run (beyond the interrupted wave 2)
- Refine jobs are priority-ordered by expected profit; purge removes stale queued work.
- QA `tests_not_executed` is always a visible minor finding (no test runner exists), never a blocking major.
- QA judges each step against its own criteria; code/test steps also get feature checks.
- Feature coverage: deterministic scaffolds fill requested features in demo workspaces at non-colliding paths
  (never overwriting real files); a live workspace is never supplemented, so a missing feature still fails QA.
- Demo code artifacts build on the deterministic skeleton so the demo shows one labelled defect then a clean repair.
- Demo code/test steps are reviewed deterministically (labelled deterministic_only); live steps keep model review.
- Sample-data notice wraps correctly on mobile.

## Operator onboarding (shipped after 1435fe8)
- The operator account owns the live "GigPilot" workspace and is recognized via `OPERATOR_EMAILS`.
- First login forces a permanent password choice (`must_change_password`): dashboard routes
  redirect to `/set-password`, server actions and data APIs return 403 until changed; the change
  runs through Better Auth's single-use reset-token flow in-process (no email transport), revokes
  other sessions and clears the flag. Verified by an 11-step live Playwright check.
- The one-time bootstrap password was handed to the owner out-of-band; it appears nowhere in the
  repo, history, env files, docs, logs or image layers.

## Explicitly out of scope (external, documented in .ai/BLOCKERS.md)
Factory, Grok, Kie, Higgsfield, Upwork, Freelancer credentials; Contra/Fiverr APIs; paid spend enablement;
public DNS / VPS deployment. AgentOS formal registration was in this list until
2026-10-04; it is now in-repo work (D19), not an external gate.
