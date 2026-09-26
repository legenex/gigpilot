# syntax=docker/dockerfile:1.7
#
# One image, four roles (selected by the compose `command`):
#   web     → Next.js marketing site      (node web/apps/web/server.js)
#   app     → Next.js dashboard + auth    (node app/apps/app/server.js)
#   worker  → pg-boss worker/orchestrator (node worker/dist/index.js)
#   migrate → one-shot Drizzle migrations (node migrate/migrate.mjs)
#
# Build from the repo root:  docker build -f ops/docker/Dockerfile -t gigpilot:<tag> .

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=1
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

# --- dependency layer (cached unless manifests change) ----------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/app/package.json apps/app/
COPY services/worker/package.json services/worker/
COPY packages/agents/package.json packages/agents/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/economics/package.json packages/economics/
COPY packages/providers/package.json packages/providers/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=gigpilot-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- build ------------------------------------------------------------------
FROM deps AS build
ARG GIT_SHA=unknown
# Inlined into the worker bundle at build time (supervision/status version).
ENV GIGPILOT_VERSION=${GIT_SHA}
COPY . .
# Build-time placeholders only; real values are injected at runtime.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    BETTER_AUTH_SECRET=build-time-placeholder-secret-not-used-at-runtime-000000
RUN pnpm --filter @gigpilot/web build \
 && pnpm --filter @gigpilot/app build \
 && pnpm --filter @gigpilot/worker build
# Self-contained migration runner (drizzle-orm + postgres bundled).
RUN pnpm --filter @gigpilot/worker exec esbuild ../../packages/db/src/migrate.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --outfile=/out/migrate/migrate.mjs \
      --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" \
 && cp -r packages/db/migrations /out/migrate/migrations
# Production node_modules for the worker bundle's externals.
RUN --mount=type=cache,id=gigpilot-pnpm,target=/pnpm/store \
    pnpm --filter @gigpilot/worker deploy --prod /out/worker \
 && cp -r services/worker/dist /out/worker/dist

# --- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    STORAGE_ROOT=/data/storage \
    MIGRATIONS_DIR=/app/migrate/migrations
RUN groupadd -g 10001 gigpilot && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin gigpilot \
 && mkdir -p /data/storage /app \
 && chown -R 10001:10001 /data
WORKDIR /app

COPY --from=build --chown=10001:10001 /repo/apps/web/.next/standalone ./web
COPY --from=build --chown=10001:10001 /repo/apps/web/.next/static ./web/apps/web/.next/static
COPY --from=build --chown=10001:10001 /repo/apps/web/public ./web/apps/web/public
COPY --from=build --chown=10001:10001 /repo/apps/app/.next/standalone ./app
COPY --from=build --chown=10001:10001 /repo/apps/app/.next/static ./app/apps/app/.next/static
COPY --from=build --chown=10001:10001 /repo/apps/app/public ./app/apps/app/public
COPY --from=build --chown=10001:10001 /out/worker ./worker
COPY --from=build --chown=10001:10001 /out/migrate ./migrate
COPY --chown=10001:10001 ops/docker/entrypoint.sh /usr/local/bin/gigpilot-entrypoint
RUN chmod 0755 /usr/local/bin/gigpilot-entrypoint

ARG GIT_SHA=unknown
ENV GIGPILOT_VERSION=${GIT_SHA}
LABEL org.opencontainers.image.source="https://github.com/legenex/gigpilot" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.title="gigpilot"

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/gigpilot-entrypoint"]
CMD ["app"]
