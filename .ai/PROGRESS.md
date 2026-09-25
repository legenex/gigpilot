# Progress log

## 2026-09-26
- Inspected gx10-01: Ubuntu 24.04 aarch64 (GB10, 121 GiB RAM), Docker 29 + Compose 5,
  Node 22.23 / pnpm 9.15, Tailscale IP 100.105.214.61, systemd user units with linger.
- Discovery: GX LiteLLM gateway (gx-mini/gx-code/gx-auto), AgentOS (no runtime
  supervision API), deploy conventions (FinancialOS pattern), free ports 4710–4729.
- Researched official docs: marketplaces (docs/research/marketplaces.md), providers
  (docs/research/providers.md), stack versions.
- Built foundation: config, contracts (+state machine tests), db schema (30 tables) +
  migration, pg-boss queue module, auth (Better Auth; sign-up + workspace bootstrap
  verified), economics (+tests: 32 passing), commands layer, design tokens, app skeletons
  (both `next build` OK).
- Minted scoped GX virtual key `gigpilot` (gx-mini/gx-code/gx-auto) — verified.
- Started gigpilot-db (postgres:17) on 127.0.0.1:4715 with external volume.
