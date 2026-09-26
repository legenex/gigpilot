#!/bin/sh
# GigPilot container entrypoint.
# Maps Docker secret files (/run/secrets/*) to the env vars the app expects,
# builds DATABASE_URL from the Postgres password, then execs the chosen role.
# Secret values are never echoed.
set -eu

load_secret() {
  # load_secret <ENV_NAME> <secret-file-name>
  if [ -z "$(printenv "$1" 2>/dev/null || true)" ] && [ -r "/run/secrets/$2" ]; then
    val="$(cat "/run/secrets/$2")"
    export "$1=$val"
  fi
}

load_secret BETTER_AUTH_SECRET better_auth_secret
load_secret GIGPILOT_ENCRYPTION_KEY encryption_key
load_secret AGENTOS_SUPERVISION_TOKEN agentos_supervision_token
load_secret INBOUND_WEBHOOK_SECRET inbound_webhook_secret
load_secret GX_API_KEY gx_api_key
load_secret FACTORY_API_KEY factory_api_key
load_secret XAI_API_KEY xai_api_key
load_secret KIE_API_KEY kie_api_key
load_secret HIGGSFIELD_API_KEY higgsfield_api_key
load_secret HIGGSFIELD_API_SECRET higgsfield_api_secret
load_secret FREELANCER_OAUTH_TOKEN freelancer_oauth_token
load_secret UPWORK_CLIENT_ID upwork_client_id
load_secret UPWORK_CLIENT_SECRET upwork_client_secret

if [ -z "${DATABASE_URL:-}" ] && [ -r /run/secrets/postgres_password ]; then
  pw="$(cat /run/secrets/postgres_password)"
  export DATABASE_URL="postgres://${POSTGRES_USER:-gigpilot}:${pw}@${POSTGRES_HOST:-db}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-gigpilot}"
fi

role="${1:-app}"
case "$role" in
  web)
    export GIGPILOT_SERVICE=web PORT="${PORT:-3000}"
    cd /app/web && exec node apps/web/server.js ;;
  app)
    export GIGPILOT_SERVICE=app PORT="${PORT:-3000}"
    cd /app/app && exec node apps/app/server.js ;;
  worker)
    export GIGPILOT_SERVICE=worker
    cd /app/worker && exec node dist/index.js ;;
  migrate)
    export GIGPILOT_SERVICE=migrate
    cd /app/migrate && exec node migrate.mjs ;;
  *)
    exec "$@" ;;
esac
