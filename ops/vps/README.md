# GigPilot public VPS deployment (prepared, not deployed)

Target: `https://gigpilot.ai` (marketing) and `https://app.gigpilot.ai` (dashboard + auth).

## What changes versus gx10-01
- **Caddy** is the only public listener (80/443) and terminates TLS for both domains
  (automatic Let's Encrypt), adding HSTS. App containers are internal only.
- **Cross-subdomain sessions**: `AUTH_COOKIE_DOMAIN=gigpilot.ai` → Better Auth issues
  `__Secure-gigpilot.session_token` for `.gigpilot.ai`, so the marketing site can render
  "Go to Dashboard" server-side with no auth flash. `APP_URL` is https → secure cookies.
- **Sign-up** switches to `SIGNUP_MODE=invite` with `AUTH_ALLOWED_EMAILS`.
- **Object storage**: set `STORAGE_DRIVER=s3` with S3/R2 credentials (secrets) — assets are
  addressed by storage key, never by provider URLs, so migration is a bulk copy of
  `gigpilot_storage` into the bucket (`rclone copy`), then flip the driver.
- **Backups**: run `pg_dump -Fc` nightly (cron/systemd timer) to an encrypted offsite bucket
  (restic or `age`-encrypted uploads); keep 14 dailies + 8 weeklies. Test restores monthly.

## Migration runbook (human gates marked ⚑)
1. ⚑ Provision VPS (Ubuntu 24.04, Docker), harden SSH, firewall 22/80/443 only.
2. Copy repo; create `ops/vps/secrets/*` (reuse gx10-01 secrets to keep sessions/encrypted
   credentials valid, or generate new ones — new `encryption_key` invalidates stored tenant
   credentials) and `ops/vps/gigpilot.env` from the example.
3. Build or load the image (`docker save gigpilot:<tag> | ssh vps docker load`).
4. Restore data: `pg_dump -Fc` from gx10-01 → `pg_restore` on the VPS; copy storage.
5. ⚑ Point DNS A/AAAA for `gigpilot.ai`, `www`, `app` to the VPS.
6. `GIGPILOT_IMAGE=gigpilot:<tag> docker compose -f compose.prod.yml up -d --wait`.
7. Verify `/api/health` on both domains, sign-in, cross-domain "Go to Dashboard", worker `/readyz`.
