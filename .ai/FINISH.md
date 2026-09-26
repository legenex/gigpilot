# Finish — remaining work to ship

State at recovery (2026-09-26 23:50 SAST): repair wave 2 present in the working tree and coherent —
monorepo typecheck PASS, lint PASS, 398 tests PASS, production builds (web/app/worker) PASS.
Deployed stack is at `2796d73` (healthy). Nothing has been discarded.

## Remaining items

1. [ ] Commit the integrated repair wave (product/design integrity + ops fixes).
2. [ ] Verified pre-deploy backup, then deploy the new SHA with `ops/gx10-01/scripts/deploy.sh`.
3. [ ] Apply migration `0002_product_integrity` (deploy.sh runs the `migrate` service).
4. [ ] Verify all services healthy, `/readyz`, Tailscale 4710/4711, version endpoint reports the SHA.
5. [ ] Purge test accounts (`ops/gx10-01/scripts/purge-test-accounts.sh --yes`).
6. [ ] Re-run full live E2E: auth + smoke + required demo flow (demo mode, no paid calls).
7. [ ] Browser gates: marketing desktop+mobile; dashboard desktop+mobile (incl. Radar, Market Lab,
       Jobs, Production, Costs, Integrations, Settings at 390px). Inspect screenshots.
8. [ ] Final reviewers: A (engineering+security), B (product+design); fix any critical/high.
9. [ ] Safe restore rehearsal (non-destructive) + confirm runtime DB grants; restart-durability check.
10. [ ] Commit final state, `pnpm secrets:scan`, push to `legenex/gigpilot`; confirm remote SHA == deployed SHA.

## Explicitly out of scope (external, documented in .ai/BLOCKERS.md)
Factory, Grok, Kie, Higgsfield, Upwork, Freelancer credentials; Contra/Fiverr APIs; paid spend enablement;
AgentOS formal registration; public DNS / VPS deployment.
