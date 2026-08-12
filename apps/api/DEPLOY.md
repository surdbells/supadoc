# Deploying the VideoMed API

The backend (`apps/api`) is a standalone PHP app — **Slim 4 + Doctrine ORM 3 +
PostgreSQL 16 + Redis**. It is deployed on its own subdomain
(**`api.dosthq.com`**); the Angular frontend is built and hosted separately on
**Cloudflare** (**`app.dosthq.com`**) and simply points at the API.

These instructions target a **Debian server running aaPanel**, but the moving
parts (PHP-FPM, PostgreSQL, Redis, an Nginx vhost with `apps/api/public` as the
document root) are the same on any host.

---

## Requirements

- **PHP ≥ 8.2** with extensions: `pdo_pgsql` (+`pgsql`), `curl`, `mbstring`,
  `openssl`, `json`, `zlib`, `fileinfo`, `opcache`
- **PostgreSQL 16**
- **Redis** (the app uses the pure-PHP `predis` client, so the `redis` PHP
  extension is **not** required)
- **Composer** and **Git**

> The app reads all configuration from `apps/api/.env`. Secrets are never
> committed — see `.env.example` for the full list.

---

## 1. Install the runtimes (aaPanel)

- **App Store → PHP 8.2** → install. Then **PHP 8.2 → Install extensions**:
  `pgsql`, `pdo_pgsql`, `fileinfo`, `opcache` (and `redis` only if you later
  switch off predis).
- **App Store → PostgreSQL** (16) → install.
- **App Store → Redis** → install.

If `pdo_pgsql` is not offered by the panel for the 8.2 build, install the client
libs first and enable the extension for that PHP version:

```bash
sudo apt-get update && sudo apt-get install -y postgresql-client libpq-dev
```

> **`pdo_pgsql` is the usual friction point on aaPanel.** The API cannot connect
> to PostgreSQL until it is enabled for the exact PHP 8.2 build serving the site.

---

## 2. Create the database

In aaPanel's PostgreSQL manager, or from the shell:

```bash
sudo -u postgres psql -c "CREATE USER videomed WITH PASSWORD 'STRONG_DB_PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE videomed OWNER videomed;"
```

Keep PostgreSQL and Redis bound to `127.0.0.1` (the default) — they should not be
exposed publicly.

---

## 3. Create the website + DNS + SSL

- **aaPanel → Website → Add site**: domain `api.dosthq.com`, PHP 8.2, no default
  database.
- **Cloudflare DNS**: add an `A` record `api` → the server's IP. Set it to
  **DNS-only (grey cloud)** for the first certificate issuance; you can switch it
  back to proxied afterwards.
- **SSL**: aaPanel → the site → **SSL → Let's Encrypt** → issue, then enable
  **Force HTTPS**.

---

## 4. Deploy the code

```bash
cd /www/wwwroot/api.dosthq.com
git clone https://github.com/surdbells/supadoc.git .
cd apps/api
composer install --no-dev --optimize-autoloader
```

Set the site's **document root** (aaPanel → site → *Site directory*) to:

```
/www/wwwroot/api.dosthq.com/apps/api/public
```

---

## 5. Configure `.env`

```bash
cd /www/wwwroot/api.dosthq.com/apps/api
cp .env.example .env
openssl rand -base64 48   # paste the output into JWT_SECRET (needs >= 32 bytes)
nano .env
```

Minimum required values:

```ini
APP_ENV=production
APP_DEBUG=false

DB_DRIVER=pdo_pgsql
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=videomed
DB_USER=videomed
DB_PASSWORD=STRONG_DB_PASSWORD
DB_SERVER_VERSION=16          # set to your installed major (e.g. 17)

JWT_SECRET=<openssl output>
JWT_ACCESS_TTL=900
JWT_REFRESH_TTL=1209600

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=            # set if your Redis has requirepass (aaPanel usually does)
REDIS_PREFIX=videomed:

# Exact browser origin(s) of the frontend that may call the API (comma-separated):
CORS_ALLOWED_ORIGINS=https://app.dosthq.com
# Used to build links in transactional emails:
APP_WEB_URL=https://app.dosthq.com
```

Integrations (leave blank to **no-op** cleanly — nothing bills until configured):

```ini
FIREBASE_PROJECT_ID=       # Google sign-in (must match the web app's projectId)
TERMII_API_KEY=            # SMS OTP
TERMII_SENDER_ID=
ZEPTOMAIL_TOKEN=           # transactional email
ZEPTOMAIL_FROM_ADDRESS=
AGORA_APP_ID=              # video/audio calls
AGORA_APP_CERTIFICATE=     # server-side only — never expose to the client
SENTRY_DSN=                # error reporting
```

> `CORS_ALLOWED_ORIGINS` **must list the exact frontend origin** or browsers will
> block every API call. The `AGORA_APP_CERTIFICATE` stays on the server.

---

## 6. Permissions

PHP-FPM runs as the `www` user under aaPanel. The app writes logs and stores
uploaded avatars on disk:

```bash
cd /www/wwwroot/api.dosthq.com/apps/api
mkdir -p var/logs public/uploads/avatars
chown -R www:www var public/uploads
chmod -R 775 var public/uploads
```

---

## 7. Create the schema + (optionally) seed

```bash
php bin/doctrine.php orm:schema-tool:update --force   # == composer schema:apply
php bin/doctrine.php orm:generate-proxies             # REQUIRED in prod — proxy auto-gen is off
chown -R www:www var                                  # www must read proxies + write var/cache
php bin/seed.php                                       # demo specialists + patient (skip in real prod)
```

> In production the EntityManager sets `autoGenerateProxyClasses(false)`, so the
> Doctrine proxies in `var/proxies/` must be generated at deploy time — skipping
> `orm:generate-proxies` gives a `Failed to open stream … var/proxies/__CG__…`
> error on the first entity load.

`schema:apply` is idempotent — re-run it after every deploy that changes an
entity. `bin/seed.php` is only for demo/staging data.

---

## 8. Nginx rewrite (Slim front controller)

In **aaPanel → the site → Config / URL Rewrite (伪静态)**, add:

```nginx
location / {
    try_files $uri $uri/ /index.php?$query_string;
}
```

That serves real files directly — including uploaded avatars under
`/uploads/avatars/…` — and routes everything else to `public/index.php`.
PHP-FPM is already wired by aaPanel's `enable-php-82.conf`. CORS and OPTIONS
preflight are handled inside the app (`CorsMiddleware`), so no extra Nginx CORS
config is needed.

---

## 9. Verify

```bash
curl -s https://api.dosthq.com/health                  # {"status":"ok"}
curl -s https://api.dosthq.com/api/public/specialties  # public data, no auth
```

- **Swagger UI**: `https://api.dosthq.com/api/docs`
- **OpenAPI JSON**: `https://api.dosthq.com/api/docs/openapi.json`

---

## 10. Point the frontend (Cloudflare)

`apps/patient/src/environments/environment.prod.ts` is already set to:

```ts
apiBaseUrl: 'https://api.dosthq.com',
loginPath: 'api/portal/auth/login',
```

Build and deploy the Angular app to Cloudflare (Pages or your pipeline):

```bash
pnpm nx build patient --configuration=production
# publish dist/apps/patient/browser
```

Make sure the frontend's live origin (`https://app.dosthq.com`) is in
`CORS_ALLOWED_ORIGINS`. For Google sign-in, also set the web `firebase` config in
`environment.prod.ts` and the matching `FIREBASE_PROJECT_ID` in the API `.env`.

---

## Redeploying

```bash
cd /www/wwwroot/api.dosthq.com && git pull
cd supadoc/apps/api && composer install --no-dev --optimize-autoloader
php bin/doctrine.php orm:schema-tool:update --force
php bin/doctrine.php orm:generate-proxies
chown -R www:www var
# aaPanel → PHP → Reload (clears OPcache)
```

**Uploaded avatars live on disk** in `public/uploads/avatars/` (git-ignored) —
they survive `git pull`, so never wipe that folder on deploy.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `could not find driver` / DB connection fails | `pdo_pgsql` not enabled for the PHP 8.2 build (see step 1). |
| Browser: CORS error on API calls | Frontend origin missing from `CORS_ALLOWED_ORIGINS`; must be the exact scheme+host. |
| `500` with a blank body | Check `apps/api/var/logs/app.log`; often a missing `.env` value or unwritable `var/`. |
| Avatar upload succeeds but image 404s | `public/uploads/avatars` not writable by `www`, or the Nginx `try_files` rewrite is missing. |
| JWT errors right after deploy | `JWT_SECRET` shorter than 32 bytes, or it changed (invalidates existing tokens — users just re-login). |
| Health OK but data endpoints 401 | Expected without a token; sign in via the frontend or `POST /api/portal/auth/login`. |
