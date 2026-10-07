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
  `openssl`, `json`, `zlib`, `fileinfo`, `gd`, `opcache`
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

# Exact browser origin(s) of the frontend(s) that may call the API (comma-separated):
# the patient app plus the backoffice + doctor portals (each its own domain).
CORS_ALLOWED_ORIGINS=https://app.dosthq.com,https://backoffice.dosthq.com,https://doctor.dosthq.com
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
mkdir -p var/logs public/uploads/avatars public/uploads/appointment-docs
chown -R www:www var public/uploads
chmod -R 775 var public/uploads
```

> **All of `public/uploads` must be writable by `www`, not just `avatars`.** New
> upload subfolders (e.g. `appointment-docs`) ship empty in git and arrive via
> `git pull` owned by the deploy user — if they aren't re-chowned, saving a file
> there fails with a 500. The redeploy step below re-chowns the whole folder.

---

## 7. Create the schema + (optionally) seed

> ⚠️ **Always review the DDL first.** `schema-tool:update --force` diffs the
> entity mappings against the live DB and executes the result unreviewed — a
> renamed/removed mapped field would DROP the column (data loss). Run the
> non-destructive preview and read it before applying:
>
> ```bash
> php bin/doctrine.php orm:schema-tool:update --dump-sql   # == composer schema:preview
> ```
>
> Proceed to `--force` only when the printed statements are the additive changes
> you expect (no unexpected DROP TABLE / DROP COLUMN).

```bash
php bin/doctrine.php orm:schema-tool:update --force   # == composer schema:apply (after reviewing schema:preview)
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

### 10a. The backoffice + doctor portals (separate Cloudflare Pages projects)

`backoffice` and `doctor` are their own Nx apps, each a standalone Cloudflare
Pages deployment. Both call the same API with a staff token they obtain
themselves, and read the API origin from their own `environment.prod.ts`
(already set to `https://api.dosthq.com`).

Create one Cloudflare Pages project per app with:

| App | Build command | Output directory |
| --- | --- | --- |
| backoffice | `npx nx build backoffice --configuration=production` | `dist/apps/backoffice/browser` |
| doctor | `npx nx build doctor --configuration=production` | `dist/apps/doctor/browser` |

Set `NODE_VERSION=22` and, for SPA routing, add a `_redirects` rule
`/* /index.html 200` (or Cloudflare's SPA fallback) so deep links resolve.

Point each Pages project at its own custom domain — **`backoffice.dosthq.com`**
and **`doctor.dosthq.com`** — and add both to `CORS_ALLOWED_ORIGINS` in the API
`.env` (already listed in the template above). The API returns the first allowed
origin when a request's Origin isn't listed, so a missing entry shows up as a
browser CORS failure on login. The backoffice needs a staff account with
`specialists.manage`; the doctor portal needs the seeded per-specialist `doctor`
logins (both handled by `bin/prod-migrate.php`).

---

## Redeploying

The repo lives at `…/api.dosthq.com/supadoc` (the aaPanel site root is its
parent), so `cd` into `supadoc` — that's where `.git` is.

```bash
cd /www/wwwroot/api.dosthq.com/supadoc && git pull origin main
cd apps/api && composer install --no-dev --optimize-autoloader
php bin/doctrine.php orm:schema-tool:update --dump-sql   # review DDL first (composer schema:preview)
php bin/doctrine.php orm:schema-tool:update --force
php bin/doctrine.php orm:generate-proxies
chown -R www:www var public/uploads   # incl. any new upload subdirs pulled this deploy
/etc/init.d/php-fpm-82 reload   # clears OPcache — match your PHP version (or aaPanel → PHP → Reload)
```

> The `git pull` + PHP reload is what makes new code take effect — without the
> reload, OPcache keeps serving the old bytecode. If `git pull` (run as root)
> refuses with **"detected dubious ownership"**, run once:
> `git config --global --add safe.directory /www/wwwroot/api.dosthq.com/supadoc`

**Uploaded avatars live on disk** in `public/uploads/avatars/` (git-ignored) —
they survive `git pull`, so never wipe that folder on deploy.

### One-time: migrate existing prod data to the consultation-flow release

The schema update above only adds nullable columns — it does **not** touch data,
and `bin/seed.php` refuses to run in production. To adapt your live specialists
(convert USD fees → Naira, add contact emails, create a doctor login per
specialist, and seed default pricing), run the idempotent migration **once**
after the schema update:

```bash
# Optional: set a shared password for all new doctor logins; otherwise each new
# login gets a random password printed once in the output.
cd /www/wwwroot/api.dosthq.com/supadoc/apps/api && DOCTOR_DEFAULT_PASSWORD='ChooseAStrongOne!' php bin/prod-migrate.php --run
```

It only converts a fee while it still looks USD-era (< 1000), only fills a
missing email/setting, and never re-passwords or clobbers an existing account —
so it's safe to re-run. The doctor emails it derives are **placeholders**; update
each specialist's email to the doctor's real inbox so invites + join links land
there. Doctors can also join from the emailed link without logging in.

### One-time: the e-prescribing + session-security release

This release adds the RxNorm drug catalogue, the structured e-prescription
(GVM-F-RX-01, branded PDF, pharmacist check page), server-enforced session idle
and absolute timeouts, and revocable staff sessions. After `git pull` and
`composer install` (it adds `setasign/fpdf`):

1. **PHP extensions**: `gd` (signature pictures are re-encoded) and `openssl`
   (encrypted file vault) must be enabled — aaPanel → PHP 8.x → Install
   extensions. Check with `php -m | grep -E 'gd|openssl'`.
2. **`.env`** — add / review:

   ```ini
   FILE_ENCRYPTION_KEY=<openssl rand -base64 32>   # REQUIRED in production; set once, never change
   APP_TIMEZONE=Africa/Lagos                        # times printed on prescriptions
   SESSION_IDLE_TIMEOUT=3600                        # server-side idle limit (seconds)
   JWT_REFRESH_TTL=43200                            # absolute session lifetime: 12h
   APP_WEB_URL=https://app.dosthq.com               # printed check page: <APP_WEB_URL>/check-prescription
   CLINIC_NAME / CLINIC_TAGLINE / CLINIC_CONTACT    # branding printed on the PDF
   ```

   Without `FILE_ENCRYPTION_KEY` (or with a malformed one) doctors cannot save or
   use signatures — the API logs the reason and tells the doctor to contact
   support; everything else keeps working.

   If your `.env` still has `JWT_REFRESH_TTL=1209600` (14 days) from the old
   template, change it — the portals' idle timeout is 15 min (patient) / 30 min
   (doctor, back office), and the server idle limit must stay ≥ that + 5 min.
3. **Schema** — review then apply (new tables `drugs`, `staff_sessions`,
   `prescription_counters`, `prescription_check_throttles`; new nullable columns
   on `prescriptions`, `sessions.last_active_at`, `patients.latest_vitals`,
   `notifications.link`, `specialists.mdcn_number` / `signature_key`;
   `prescriptions.appointment_id` becomes nullable):

   ```bash
   php bin/doctrine.php orm:schema-tool:update --dump-sql   # review
   php bin/doctrine.php orm:schema-tool:update --force
   php bin/doctrine.php orm:generate-proxies
   ```
4. **Load the drug catalogue** (21,514 prescribable RxNorm products, shipped in
   `resources/rxnorm/`; re-run after refreshing it from a newer release with
   `php bin/build-rxnorm-dataset.php /path/to/RxNorm_full_prescribe_MMDDYYYY.zip`):

   ```bash
   php bin/import-rxnorm.php
   ```

   If this step is skipped, the first medicine search loads the catalogue
   automatically (a few seconds, once); running it at deploy time avoids that
   first-search wait.
5. **Backfill old prescriptions + canonical allergy severities** (numbers,
   `active` status, valid-until, prescriber; legacy Low/Medium/High allergy
   severities → mild/moderate/severe so the prescribing panel ranks them) — part
   of the idempotent migration: `php bin/prod-migrate.php --run`.
6. **Permissions** — the vault lives in `var/vault`: `mkdir -p var/vault && chown -R www:www var`.
7. **Cron** — no new job: `bin/send-reminders.php` (every 5 min) now also stores
   prescription expiries and sends the "expires in N days" reminders.
8. Doctors and back-office staff are asked to **sign in once** after the deploy
   (their old refresh tokens are not bound to a server session).

The prescription rules (default validity, reminder lead time, check-page lock-out,
download-link lifetime) are editable in the back office → Pricing & settings.

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
