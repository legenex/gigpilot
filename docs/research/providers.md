# Provider research (official docs, read 2026-09-26)

Condensed from official documentation. Items marked **UNCERTAIN** were unclear
or contradictory in the docs — adapters must handle both variants defensively.

## Factory.ai (Droid)

- Programmatic paths: **`droid exec`** headless CLI (primary), `@factory/droid-sdk`
  (TypeScript, wraps the CLI — still needs the `droid` binary), stream-jsonrpc over
  stdio, REST `https://api.factory.ai` (Sessions API is selected-orgs only).
- Install: `curl -fsSL https://app.factory.ai/cli | sh` or `npm i -g droid`.
- Auth: `FACTORY_API_KEY=fk-...` (https://app.factory.ai/settings/api-keys).
- Flags: `-m/--model <id>`, `-r/--reasoning-effort`, `--auto low|medium|high`
  (default read-only), `-o/--output-format text|json|stream-jsonrpc`, `--cwd`,
  `--append-system-prompt`, `--disabled-tools`, `--tag`.
- `-o json` output: `{"type":"result","subtype":"success","is_error":false,"duration_ms":..,"num_turns":..,"result":"...","session_id":"..."}` — **no usage/cost fields**. Token usage (`tokenUsage.{inputTokens,outputTokens,factoryCredits}`) only via SDK / stream-jsonrpc.
- **Factory Router = model id `"auto"`** (SDK docs). `droid exec -m auto` is
  UNCERTAIN (not shown in CLI docs) — fall back to omitting `-m`.
- Billing: Factory Standard Credits (tokens × model multiplier). Plans $20/$100/$200.
- Zero-cost health: `droid --version` (binary), SDK `listModels()` for auth (UNCERTAIN whether it validates the key).
- Not installed on gx10-01 (2026-09-26); no FACTORY_API_KEY present.

## xAI / Grok

- Base `https://api.x.ai/v1`, `Authorization: Bearer $XAI_API_KEY`.
- **Responses API `POST /v1/responses`** is recommended; Chat Completions is legacy
  (no server-side tools). Live Search `search_parameters` is **deprecated/removed**.
- Models (per 1M tokens in/cached/out, <200k prompt): `grok-4.7` $2/$0.50/$6
  (flagship), `grok-4.3` $1.25/$0.20/$2.50 (cheap tier, 1M ctx), `grok-build-0.1` $1/$0.20/$2.
  `grok-4-fast*`, `grok-code-fast-1`, `grok-3` retired 2026-05-15 (redirect to 4.3).
- Server tools: `"tools":[{"type":"web_search"},{"type":"x_search"}]`, `max_turns`;
  citations in `citations`. Web search $5 / 1k calls; X search $5 / 1k posts.
- Structured output (Responses): `text: {format: {type:"json_schema", name, schema, strict:true}}`.
- **Cost**: every response has `usage.cost_in_usd_ticks` (1 USD = 1e10 ticks) — exact billed amount.
- Zero-cost auth check: `GET /v1/api-key` (key metadata, blocked/disabled flags); `GET /v1/models`.
- Guideline violation caught pre-generation costs $0.05.
- gx10-01's `grok` CLI is OIDC-authenticated for Nick — **not** reusable as a server key.

## Kie.ai

- Base `https://api.kie.ai`, `Authorization: Bearer <KEY>`.
- Create: `POST /api/v1/jobs/createTask` `{"model":"nano-banana-2","callBackUrl":"...","input":{...}}`
  → `{"code":200,"msg":"success","data":{"taskId":"..."}}`.
- Poll: `GET /api/v1/jobs/recordInfo?taskId=...` → `data.state` ∈ waiting|queuing|generating|success|fail;
  **`data.resultJson` is a JSON string** → `{"resultUrls":[...]}`; `creditsConsumed`, `failCode`, `failMsg`.
  Poll 2–3s with backoff; give up after 10–15 min.
- Callback HMAC: `X-Webhook-Timestamp`, `X-Webhook-Signature` = base64(HMAC-SHA256(`taskId + "." + timestamp`, key)). Payload may use `taskId` or `task_id` (UNCERTAIN) — handle both.
- Balance / zero-cost auth: `GET /api/v1/chat/credit` → `data` = remaining credits.
- Envelope codes: 200 ok, 401 auth, 402 insufficient credits, 404, 408 upstream timeout,
  422 validation, 429 rate limited, 433 sub-key limit, 455 maintenance, 500, 501 generation failed, 505 disabled.
  Check HTTP status **and** body `code`.
- **1 credit = $0.005.** Failed generations refunded. Rate limit 20 creates / 10s.
- Result URLs expire (24h–14d, contradictory) → download immediately into GigPilot storage.
- Indicative prices: `nano-banana-2` 8/12/18 cr (1K/2K/4K), `google/imagen4-fast` 4 cr,
  `gpt-image-2-text-to-image` 6/10/16 cr, `seedream/5-lite-text-to-image` 5.5 cr,
  `flux-2/pro-text-to-image` 5–7 cr, `veo-3-1` Fast 60 cr (720p), Lite 30 cr, Quality ~250 cr,
  `kling-3.0/video` 14 cr/s (720p), `bytedance/seedance-2-fast` 11.7–24.8 cr/s,
  `grok-imagine/image-to-video` 2.4–8 cr/s.

## Higgsfield (Cloud API)

- Base `https://api.higgsfield.ai`. Auth header **`Authorization: Key {KEY_ID}:{KEY_SECRET}`** (legacy `hf-api-key`/`hf-secret` still accepted).
- Generate: `POST /{endpoint-id}` e.g. `/higgsfield-ai/soul/v2/standard` `{"prompt":"..."}` →
  `{"status":"queued","request_id":"...","status_url":"...","cancel_url":"..."}`.
- Poll: `GET /requests/{request_id}/status` → queued|in_progress|completed|failed|nsfw|canceled;
  output `images:[{url}]` / `video:{url}`. Poll 2s→10s with jitter.
- Webhook: `?hf_webhook=<url>`; payload `{request_id,status,error,payload}`; dedupe on request_id+status.
- **Free pre-flight estimate**: `POST /estimate/{endpoint}` same body → `{"credits":"1.500","usd":"0.094"}` — also the zero-cost auth check (401 = bad key).
- No cost field in status responses and no balance endpoint → record the estimate as cost.
- Concurrency limit per account (e.g. 4) returns **400** (not 429). 403 = insufficient credits.
- **No idempotency key** — never auto-retry a generate POST after an ambiguous timeout.
- Example rates: Soul 2 $0.0032/img, Z-Image Turbo $0.015/img, Grok Imagine 2.0 $0.04/img,
  Kling 3.0 $0.0462/s, Seedance 2.5 $0.144/s (may include launch discounts).

## GX cluster (local, gx10-01)

- LiteLLM gateway: host `http://127.0.0.1:4000/v1`; containers on docker network
  `gx_gateway` → `http://gx-litellm:4000/v1`. Key required (virtual key alias `gigpilot`,
  models gx-mini, gx-code, gx-auto; stored at `/srv/projects/gigpilot/secrets/gx_api_key`).
- Live-verified 2026-10-04 on this gateway with the `gigpilot` key: `gx-mini`,
  `gx-code`, `gx-auto`. Do not invent aliases. AgentOS itself routes on
  `gx-auto` / `gx-max`; GigPilot product inference uses this virtual key and
  must not call `gx-max`.
- Historical notes: `gx-mini` was cheap/short tasks; `gx-code` heavier
  drafting. Re-check `/v1/models` before changing product defaults.
- Gateway does not retry or fall back; clamps max_tokens; returns 429 over 32 parallel.
- Liveness without key: `GET /health/liveliness`.
