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
JWT_REFRESH_TTL=43200         # also the ABSOLUTE session lifetime (12h); never 1209600 (14 days)
SESSION_IDLE_TIMEOUT=3600     # server idle limit; keep >= the portals' idle timeout + 5 min

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=            # set if your Redis has requirepass (aaPanel usually does)
REDIS_PREFIX=videomed:
# Redis also holds "who is in the call" for the appointment indicators (keys
# expire on their own, nothing to migrate). If Redis is unreachable the
# indicators simply show nobody — calls are unaffected.

# Exact browser origin(s) of the frontend(s) that may call the API (comma-separated):
# the patient app plus the backoffice + doctor portals (each its own domain).
CORS_ALLOWED_ORIGINS=https://app.dosthq.com,https://backoffice.dosthq.com,https://doctor.dosthq.com
# Used to build links in transactional emails:
APP_WEB_URL=https://app.dosthq.com

# How many proxies in front of the API append to X-Forwarded-For (Cloudflare,
# nginx…): the rate limiter takes the client IP that many entries from the
# right. Check against one real request's X-Forwarded-For on the box: set too
# low and everyone behind Cloudflare shares one bucket; too high and the IP can
# be spoofed.
TRUSTED_PROXY_HOPS=1
# Rate limits per RATE_LIMIT_WINDOW seconds (defaults shown; all optional):
RATE_LIMIT_WINDOW=60
RATE_LIMIT_REQUESTS=60              # anonymous traffic per IP, incl. sign-in + OTP endpoints
RATE_LIMIT_AUTH_REQUESTS=60         # /api/auth/refresh + /api/auth/logout per IP (own bucket)
RATE_LIMIT_BEARER_IP_REQUESTS=1200  # signed-in traffic per IP (a clinic behind one NAT address)
RATE_LIMIT_USER_REQUESTS=240        # signed-in traffic per user
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
# Booking attachments used to be written here (public). They are medical
# documents: prod-migrate step 7 moves them into the private vault — never
# serve anything left behind.
location ^~ /uploads/appointment-docs/ {
    return 404;
}

location / {
    try_files $uri $uri/ /index.php?$query_string;
}
```

That serves real files directly — including uploaded avatars under
`/uploads/avatars/…` — and routes everything else to `public/index.php`.
The `appointment-docs` block must sit above `location /` (add it once; reload
Nginx after saving).
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
/etc/init.d/php-fpm-84 reload   # clears OPcache — match your PHP version, e.g. php-fpm-84 on api.dosthq.com (or aaPanel → PHP → Reload)
```

**The same as one command** (every step is safe to re-run). The schema step
prints the DDL it is about to apply (also saved to `var/schema-pending.sql`) and
**stops before applying it** if it would drop a table/column or change a
column's type — releases only ever add tables / nullable columns, so that means
something unexpected: back up the database and review it first. `prod-migrate`
runs its one-time steps (0–2) only once per database; the rest are idempotent:

```bash
cd /www/wwwroot/api.dosthq.com/supadoc && git pull origin main && cd apps/api && composer install --no-dev --optimize-autoloader && rm -rf var/cache/doctrine* && php bin/doctrine.php orm:schema-tool:update --dump-sql | tee var/schema-pending.sql && if grep -qiE 'DROP TABLE|DROP SEQUENCE|ALTER [^ ]+ TYPE ' var/schema-pending.sql || grep -iE 'ALTER TABLE [^ ]+ DROP ' var/schema-pending.sql | grep -qviE 'DROP (CONSTRAINT|INDEX) '; then echo 'STOP: this schema change drops or retypes data (var/schema-pending.sql). Back up the database, review it, then apply by hand.'; false; fi && php bin/doctrine.php orm:schema-tool:update --force && php bin/doctrine.php orm:generate-proxies && php bin/prod-migrate.php --run && mkdir -p var/vault && chown -R www:www var public/uploads && /etc/init.d/php-fpm-84 reload && sleep 2 && echo "--- API check (expect 401):" && curl -s -w " [%{http_code}]\n" -X POST https://api.dosthq.com/api/public/call/check/presence && echo "--- Redis check (expect PONG):" && php -r 'require "vendor/autoload.php"; Dotenv\Dotenv::createImmutable(".")->safeLoad(); $r = new Predis\Client(["host" => $_ENV["REDIS_HOST"] ?? "127.0.0.1", "port" => (int) ($_ENV["REDIS_PORT"] ?? 6379), "password" => ($_ENV["REDIS_PASSWORD"] ?? "") ?: null]); echo $r->ping(), PHP_EOL;'
```

It ends with two checks: the API answers `401` ("This join link is invalid or
has expired") — a `404` means the old code is still served, reload PHP again —
and Redis answers `PONG` (otherwise fix the `REDIS_*` values in `.env`; calls
still work, the "in the call" indicators just stay hidden).

`prod-migrate` also prints `clock_repair` (step 13): `done` or `not_needed` is
normal. `pending` or `would_record` means the clock repair still has to run —
see "One-time: the clock fix" (scheduling stays paused and the cron refuses to
run until it has). `stragglers` means rows were written on the wrong clock
after the recorded repair (scheduling is not paused) — see the same section,
step 4. `refused` with `recorded_for_other_zone` means `date.timezone` changed
(see "Never change `date.timezone`" there). `error` means step 13 could not
run; nothing was changed — see the same section.

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
   APP_WEB_URL=https://patient.dosthq.com           # the PATIENT app: patient email links + the check page printed on PDFs
   STAFF_WEB_URL=https://doctor.dosthq.com          # the DOCTOR portal: links in doctor/staff emails
   PATIENT_WEB_URLS=https://patient.dosthq.com,https://patient.betacrest.com   # every patient site (first = default)
   STAFF_WEB_URLS=https://doctor.dosthq.com,https://doctor.betacrest.com       # every doctor site, same order
   BACKOFFICE_WEB_URL=https://backoffice.dosthq.com # optional: link in the "doctor ready for review" email (else the backoffice.* CORS origin)
   CLINIC_NAME / CLINIC_TAGLINE / CLINIC_CONTACT    # branding printed on the PDF
   ```

   Without `FILE_ENCRYPTION_KEY` (or with a malformed one) doctors cannot save or
   use signatures — the API logs the reason and tells the doctor to contact
   support; everything else keeps working.

   Several deployments share this API (the dosthq and betacrest test groups):
   each user's site is remembered at sign-in and their links follow it, so list
   every site in PATIENT_WEB_URLS / STAFF_WEB_URLS (paired by position) and keep
   all of them in CORS_ALLOWED_ORIGINS.

   If your `.env` still has `JWT_REFRESH_TTL=1209600` (14 days) from the old
   template, change it — the portals' idle timeout is 15 min (patient) / 30 min
   (doctor, back office), and the server idle limit must stay ≥ that + 5 min.
3. **Schema** — clear the cached entity mappings once (deploys from this
   release on refresh them automatically), then review and apply (new tables `drugs`, `staff_sessions`,
   `prescription_counters`, `prescription_check_throttles`; new nullable columns
   on `prescriptions`, `sessions.last_active_at`, `patients.latest_vitals`,
   `notifications.link`, `specialists.mdcn_number` / `signature_key`;
   `prescriptions.appointment_id` becomes nullable):

   ```bash
   rm -rf var/cache/doctrine*                                # stale mappings hide new columns
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

### One-time: the past-appointment lifecycle release

1. **Schema** — the redeploy one-liner's `schema-tool:update` adds seven
   nullable columns to `appointments` (`closure_reason`, `no_show`,
   `closed_at`, `doctor_first_joined_at`, `patient_first_joined_at`,
   `rescheduled_by`, `refunded_amount`). The new `missed` status needs no DDL
   (`status` is a varchar). No `prod-migrate` step: existing rows are left as
   they are and the cron closes them.
2. **Cron** — no new job: `bin/send-reminders.php` now runs
   `PastAppointmentCloser`. Its **first run closes the backlog**: past
   pending / rescheduled bookings (ended over 30 minutes ago — the doctor's
   confirm grace; not ones both sides joined the call of) → cancelled
   (`expired_unconfirmed`) with a full refund of paid ones; confirmed ones
   past `missed_after_hours` with no proof → missed (refund by the no-show
   settings); ones with proof → completed. Anything that started over 3 days
   ago closes quietly (audited, refunded, no notices and no wallet receipt
   email). Each pass pages through the whole backlog (200 rows a page, up to
   50 pages a run); a failing row is logged (`[past-appointments]` /
   `[auto-complete]` in the PHP error log, `errors` in the cron summary) and
   never stops the others. To see what it will touch first (read-only):

   ```sql
   SELECT status, payment_status, COUNT(*) FROM appointments a JOIN specialists s ON s.id = a.specialist_id
   WHERE a.deleted_at IS NULL AND a.status IN ('pending','rescheduled','confirmed')
     AND a.scheduled_at + (s.slot_minutes || ' minutes')::interval < NOW()
   GROUP BY 1, 2;
   ```
3. **Settings** — back office → Booking settings (GET/PATCH `/api/settings/booking`):
   `missed_after_hours` (12), `unconfirmed_expiry_minutes_after_end` (0),
   `noshow_patient_refund_pct` (0), `noshow_both_refund_pct` (0),
   `late_cancel_hours` (0 = off), `late_cancel_refund_pct` (100),
   `doctor_noshow_alert_threshold` (2 in 30 days). Set them before the first
   cron run if the defaults don't suit.

### One-time: the wallet top-up double-credit fix

A top-up is now credited at most once (locked re-read + a compare-and-set that
also requires the entry never posted), and only when Paystack's verified amount
**and** currency equal what the top-up asked for; otherwise it is held as
`review` for support (nothing credited, the patient is told, audited). An entry
that already moved money (`posted_at` / `balance_after` set) is never credited,
failed or held again, whatever its status says.

1. **No schema change, no `prod-migrate` step** — the `review` / `resolved`
   statuses fit the existing `status` varchar, and the verified amount goes in
   the existing `metadata` column.
2. **Ships together with the card-payment fix**: `WalletService::settleTopup()`
   now takes the verified amount + currency, and the webhook calls it that way.
3. **Paystack fees** — the verified amount is what was paid *to us*: Paystack's
   `requested_amount` (what we initialised) when the charge covers it, else
   `amount`. So "pass transaction charges to the customer" on the Paystack
   dashboard neither blocks top-ups nor credits Paystack's fee (card payments
   read the same figure). Nothing to change on the dashboard; a top-up keeps
   the gross amount and fee in `metadata.gateway`.
4. **`POST /portal/wallet/verify` answers**: `200` credited (or already
   credited — no second receipt, no second Paystack call), `402` payment not
   completed (was `200` + `status: failed`), `409` still processing or held for
   review. A `402`/`409` is only given after re-reading the ledger: if the
   webhook credited it meanwhile the answer is `200` "already in your wallet".
5. **Right after deploying**, from `apps/api`, in this order:

   ```bash
   php bin/wallet-reconcile.php                             # read-only report; exit 1 = findings (see below)
   php bin/wallet-topup-sweep.php --max-age-days=0          # DRY RUN: asks Paystack about every never-credited top-up, changes nothing
   php bin/wallet-topup-sweep.php --run --max-age-days=0    # credits the ones Paystack says were paid (once, exact amount only)
   ```

   The sweep is the fix for top-ups that were **paid but never credited**
   (the old verify marked a not-yet-final payment `failed`, the old webhook
   ignored `failed` rows, and Paystack does not resend a webhook). It only
   touches top-ups that never moved money, credits through `settleTopup()`
   (receipt + in-app notice), holds a mismatched amount for support, never
   marks anything failed, and is safe to repeat. Then work through the
   reconciler's findings (below) until it exits `0`.
6. **Cron** (both safe to repeat; only the sweep with `--run` writes, and only through `settleTopup()`):

   ```bash
   # 20 3 * * *  cd /www/wwwroot/api.dosthq.com/supadoc/apps/api && php bin/wallet-topup-sweep.php --run >> var/log/wallet-topup-sweep.log 2>&1
   # 40 3 * * *  cd /www/wwwroot/api.dosthq.com/supadoc/apps/api && php bin/wallet-reconcile.php >> var/log/wallet-reconcile.log 2>&1
   ```

   The nightly sweep makes one Paystack verify call per never-credited top-up
   started in the last 30 days and at least 15 minutes old (150 ms apart; exit
   `1` if some could not be checked) — the backstop for a missed or refused
   webhook.

#### Wallet reconciliation

`bin/wallet-reconcile.php` **never changes data** (it runs in one read-only
database transaction that is rolled back). For every wallet it compares
`wallets.balance` with the signed sum of its successful ledger entries and
lists: references credited more than once (a top-up whose recorded balance
jumped by a multiple of its amount, or one credited twice around a booking —
the jump then shows on the booking and the top-up is named), entries that
moved money but are not marked success (the old late-failure race), Paystack
transactions credited twice, ledger rows inconsistent with their wallet,
top-ups held for review, and credited top-ups whose verified amount differs.
Exit `0` = clean, `1` = findings, `2` = could not run.

**Correcting a finding** — never edit `wallets.balance` and never delete or
alter ledger rows by hand. Corrections go through `WalletService` (locked,
idempotent, audited), from `apps/api`; set `W` once per shell:

```bash
W='require "vendor/autoload.php"; Dotenv\Dotenv::createImmutable(".")->safeLoad(); $w = (new DI\ContainerBuilder())->addDefinitions("config/container.php")->build()->get(App\Infrastructure\Service\WalletService::class);'
```

Work through them in this order:

1. **Entry that moved money but is not marked success** (`posted_entry_not_success`
   — a top-up credited, then marked `failed` by the old race). The money **is**
   in the wallet and the patient paid it once: restore its status — no balance
   change; refused (nothing changed) if the wallet doesn't hold the money:
   `php -r "$W"' var_dump($w->restorePostedTopup("<ref>", "Credited <date>; old race left it failed", "Support: <name>")?->toArray());'`
   Never credit it again, never claw it back as a "duplicate", and don't ask
   the patient to verify it again. (`recordLedgerDiscrepancy()` refuses while
   such an entry is unrestored.)
2. **Balance still differs from its ledger** (e.g. "vmw_… looks credited 2 times"):
   1. record the difference, so the ledger accounts for the whole balance (the
      balance itself does not change; a no-op once they agree):
      `php -r "$W"' var_dump($w->recordLedgerDiscrepancy("<wallet_id>", "Top-up <ref> credited twice (old race)", "Support: <name>")?->toArray());'`
   2. finance decides what happens to the money. To recover a duplicate the
      patient still holds (refused if the balance is short):
      `php -r "$W"' var_dump($w->debit("<patient_id>", "NGN", "<amount>", "adjustment", "clawback_<ref>", "Duplicate top-up credit recovered")->toArray());'`
      If the balance was *below* the ledger (money lost), make it good with
      `credit(…, "adjustment", "makegood_<wallet_id>_<ref or YYYYMMDD>", "…")`.
   Every correction gets **its own** reference: re-running the same command is
   a no-op, but a reference already used for a different amount/direction/wallet
   is refused (`LedgerReferenceConflictException`, nothing posted) — never
   silently ignored.
3. **Top-up held for review**: find the reference in the Paystack dashboard. If
   it was refunded there, close it with no credit; otherwise credit what
   actually arrived (posted as a separate `adjustment`, with a receipt):
   `php -r "$W"' var_dump($w->resolveHeldTopup("<ref>", null, "Refunded on Paystack <date>", "Support: <name>")?->toArray());'`
   `php -r "$W"' var_dump($w->resolveHeldTopup("<ref>", "<amount received>", "Paystack shows <amount> received", "Support: <name>")?->toArray());'`
4. **Anything else** (Paystack transaction credited twice, inconsistent ledger
   row, verified amount differs): should never happen — check the history first
   (`SELECT * FROM audit_events WHERE resource_id = '<ref>' ORDER BY created_at;`)
   and escalate to engineering before changing anything.

**Never `credit()` a top-up by hand** (it is refused for type `topup`). A
top-up that was paid but never credited is credited by
`php bin/wallet-topup-sweep.php --run` (it asks Paystack first; add
`--max-age-days=0` for one older than 30 days); if Paystack shows a different
amount, the sweep holds it and step 3 applies.

Re-run `php bin/wallet-reconcile.php` until it exits `0`. The `[INFO]` lines
don't affect the exit code: top-ups never credited and still pending/failed
after 48 h are mostly abandoned checkouts — the nightly sweep asks Paystack
about the last 30 days' and credits any that were paid.

### One-time: the card-payment fix (payment intents + slot lock)

Every card checkout (booking, follow-up acceptance, guest) is now recorded at
pay-init (`payment_intents`) and pays for one thing, once — consumed in the
same transaction as what it pays for. A paid one nothing uses is credited to
the patient's wallet. Every slot-taking write holds the doctor's slot lock.

1. **Schema** — the redeploy one-liner's `schema-tool:update` creates the
   `payment_intents` table (+ 3 indexes; nothing dropped or retyped).
2. **`prod-migrate` step 10** (the one-liner's `--run`) adds two partial unique
   indexes on `appointments` — `uniq_appointments_payment_reference` (one
   booking per card payment) and `uniq_appointments_live_slot` (one live
   booking per doctor per start time). Each is created only when no existing
   rows break it; otherwise it is listed under `unique_indexes_blocked` with
   the appointment ids, nothing is changed, and the deploy carries on (the code
   is already protected; the indexes are a backstop). Resolve a blocked one by
   hand — e.g. cancel + refund one of a doubly-booked pair through the back
   office — and re-run `php bin/prod-migrate.php --run`. Later schema updates
   keep these indexes (`RawIndexes` is the schema tool's listener). Each index
   is checked and created in its own short transaction that first locks
   `appointments` against writes (up to 10 s; reads go on) — if the table
   stays busy it is reported `busy` and nothing changes: re-run the step.
   Step 10 also prints `card_payment_anomalies` (read-only — see "Card
   payments to review" below).
3. **The Paystack webhook now requires its signature** (401 otherwise) and
   answers `503` when Paystack can't confirm a charge just then (unreachable,
   or its verify still says pending / ongoing), so Paystack retries; it is no
   longer per-IP rate-limited. Check that the Paystack
   dashboard's webhook URL is `https://api.dosthq.com/api/webhooks/paystack`
   and that `PAYSTACK_SECRET_KEY` is the same mode (live/test) as the keys the
   front-ends use — a wrong key now means every event is refused. After
   deploying, the dashboard's webhook log should show `200`s.
4. **Cron** — no new job: `bin/send-reminders.php` prints a `card payments:`
   line. It re-checks unconfirmed checkouts with Paystack (from 15 minutes old:
   every 15 minutes for two hours, then every two hours; expired after a day when Paystack says it is still unpaid — while Paystack can't be asked it stays open and is asked again),
   and credits a paid one nothing used for `CARD_INTENT_CREDIT_AFTER_MINUTES`
   (optional `.env`, default `30`) to the wallet, with an in-app notice and the
   wallet receipt. One it can't credit automatically is held for review
   (`held_for_review=N` on that line) and leaves the queue; a payment the
   sweep fails on goes to the back of the queue, so failures never hold up
   the others.
5. **Checkouts in flight at the deploy** (started on the old code) are adopted
   when their webhook arrives or the patient confirms them — only for the
   patient Paystack's record names (`metadata.patient_id`), for the purpose it
   was paid for, and only if it was paid no earlier than 24 hours before the
   first checkout this release records; never paid out twice. A pre-release
   **guest** payment on an appointment that had a guest removed (its fee may
   already have been refunded) is recorded but held for review. Anything else
   is refused with "contact support". **Card charges orphaned before this
   release have no record**: once, list successful `vma_…` transactions in the
   Paystack dashboard; for each, read its metadata (`patient_id`, `purpose`,
   `appointment_id`) and credit it ONLY if all of these hold:
   - no booking or guest used it:
     `SELECT id FROM appointments WHERE payment_reference = '<ref>' OR CAST(guests AS text) LIKE '%<ref>%';` returns nothing;
   - no wallet credit: `SELECT 1 FROM wallet_transactions WHERE reference = 'fu_card_credit_<ref>';` returns nothing;
   - no payment record: `SELECT status FROM payment_intents WHERE reference = '<ref>';` returns nothing
     (if it returns a row, the system already placed it — leave it);
   - for a guest payment (`purpose` `guest_invite`): its appointment never had
     a guest removed or refunded — removing a guest deleted the only copy of
     the reference, so the queries above can't see it:
     `SELECT 1 FROM audit_events ae WHERE ae.appointment_id = '<metadata.appointment_id>' AND (ae.action = 'appointment.guest_removed' OR (ae.resource_type = 'guest' AND EXISTS (SELECT 1 FROM wallet_transactions wt WHERE wt.reference = 'appt_guest_refund_' || ae.resource_id)));`
     returns nothing (if it returns a row, escalate — don't credit).
   Then credit the patient named in the metadata under that same key (so it
   can never be credited twice; `W` as in the wallet section above):
   `php -r "$W"' var_dump($w->credit("<metadata.patient_id>", "NGN", "<amount>", "refund", "fu_card_credit_<ref>", "Unused card payment <ref> — added to your wallet")->toArray());'`

#### Card payments to review

Every `prod-migrate` run (dry run too) prints `card_payment_anomalies` —
read-only; nothing is changed. Each entry needs a person:

- `reference_used_twice` / `used_and_credited` — the old check-then-act code
  let one card payment pay for two bookings / guests, or be used AND credited
  to the wallet: money was created. Check the history
  (`SELECT * FROM audit_events WHERE metadata::text LIKE '%<ref>%' ORDER BY created_at;`)
  and escalate to finance before changing anything (e.g. a clawback debit
  under `clawback_<ref>`, as for a duplicate top-up above).
- `intent_consumed_and_credited` — must never happen with payment intents:
  escalate to engineering.
- `intents_in_review` — a paid card payment the system would not place by
  itself (`failure_reason` says why: a currency the wallet doesn't hold, a
  wallet key already used differently, a pre-release guest payment that may
  have been refunded). Decide, then close it — crediting the wallet (once,
  under `fu_card_credit_<ref>`, with a receipt and an in-app notice) or with no
  credit when it was settled another way:
  `P='require "vendor/autoload.php"; Dotenv\Dotenv::createImmutable(".")->safeLoad(); $p = (new DI\ContainerBuilder())->addDefinitions("config/container.php")->build()->get(App\Infrastructure\Service\PaymentIntentService::class);'`
  `php -r "$P"' var_dump($p->closeReview("<ref>", "<amount to credit>", "Checked: unused, paid <date>", "Support: <name>")?->toArray());'`
  `php -r "$P"' var_dump($p->closeReview("<ref>", null, "Already refunded as appt_guest_refund_<gid>", "Support: <name>")?->toArray());'`

### One-time: reference data, specialist photos + the back-office dashboard

Specialties now come from a back-office-managed list (Reference data), the back
office uploads specialist photos instead of taking a link, and the dashboard is
built from `GET /api/admin/dashboard`.

1. **Schema** — the redeploy one-liner's `schema-tool:update` creates the
   `reference_items` table (+ 3 indexes) and adds `idx_audit_created` on
   `audit_events`. Nothing is dropped or retyped.
2. **`prod-migrate` step 11** (the one-liner's `--run`) seeds the `specialty`
   list. Every specialty a doctor already has is added, in the spelling most of
   them use. The standard list (General Practice, Cardiology, …) is added once,
   recorded in the `prod_migrate.reference_specialty_seeded` setting, so a
   standard item deleted later is not brought back. It only adds rows and never
   changes a doctor. The report shows `reference_specialties_added` and
   `reference_standard_list`. Until the step runs, the API still takes any typed
   specialty, and the forms fall back to free text.
3. **After the deploy**, open Back office → Reference data and tidy the list.
   Rename an item to fix its spelling: every doctor with that specialty follows
   in the same transaction, and each change is audited. Switch off what you
   don't offer: doctors who already have it keep it. An item in use can't be
   deleted, and the list always keeps at least one item switched on.
4. **Photos** — the back office uploads to `public/uploads/avatars/` (the same
   folder and checks as the doctor's own avatar upload; the one-liner's `chown`
   covers it). Staff `PATCH /api/specialists/{id}` and a doctor's own
   `PATCH /api/doctor/profile` no longer accept a `photo_url` link: only clearing
   it, or the current value, is allowed. Existing photo links keep showing.
5. **Permissions** — the dashboard opens for anyone holding `monitoring.view`,
   `appointments.view`, `specialists.manage`, `payouts.manage` or
   `support.manage`; each section shows only for the permission its page needs.
   Staff land on the first page their role can open. A staff member's token
   carries the permissions it was issued with, so a permission change shows
   after their next sign-in.

### One-time: private medical documents

From this release a patient's medical documents are **private by default**:
doctors see only what the patient shares with them (the whole folder or
selected documents, for a period or with no end date), and every file a doctor
opens is recorded for the patient. On release **nothing is shared** — every
doctor loses the implicit access they had, and patients re-share what they
want (they are told once, with no medical details).

It ships in **two commits, in two phases, in one maintenance window** outside
clinic hours: **C1** = `apps/api/**` only (the private cutover, sharing switched
off); **C2** = `libs/shared/**` + `apps/patient/**` + `apps/doctor/**` (the
sharing screens). The API must be live before any front end that uses it.

**Phase 1 — private cutover (API only, `DOC_SHARING_ENABLED` off).**

1. On the API box, before deploying: `cd /www/wwwroot/api.dosthq.com/supadoc/apps/api && php bin/doc-sharing-check.php`.
   Proceed only at **`live_calls=0`** — the cutover hides documents in a live
   call. (`tables=missing` is expected before the deploy.)
2. Push **C1** and run the redeploy one-liner above. The schema update creates
   seven tables (`document_access_grants`, `document_access_grant_documents`,
   `document_access_hidden`, `document_access_requests`,
   `document_access_blocks`, `document_access_log`,
   `document_access_submissions`) and drops nothing;
   `prod-migrate` step 10 adds their five partial unique indexes (report
   `unique_indexes`), and step 12 reports `documents_private_notice: skipped
   (sharing not enabled)`. Leave `DOC_SHARING_ENABLED` unset (off).
3. Verify:
   ```bash
   php bin/doc-sharing-check.php --expect-tz="$(curl -s https://api.dosthq.com/health/ready | php -r 'echo json_decode(stream_get_contents(STDIN))->tz;')"
   ```
   (Use the host this box serves — e.g. `https://vmapi.betacrest.com/health/ready`
   for the betacrest deployment.) Expect `tz_check=ok` (it exits 1 when the CLI's time zone differs from
   PHP-FPM's — fix `date.timezone` in the CLI php.ini first: timestamps are
   stored in the process zone), `flag=off`, `tables=present`,
   `indexes=present`, `active_grants=0 pending_requests=0`. Smoke query:
   ```sql
   SELECT (SELECT count(*) FROM document_access_grants) AS grants,
          (SELECT count(*) FROM document_access_requests WHERE status='pending') AS pending,
          (SELECT count(*) FROM document_access_hidden WHERE cleared_at IS NULL) AS hidden;
   ```
   A doctor's `GET /api/doctor/appointments/{id}/patient-documents` for a known
   consultation now answers `[]`, and opening a file answers 404 `not_shared`.
4. **Never `git revert` C1** — that would show every patient's documents to
   every doctor they booked again. A broken C1 is fixed forward with a hotfix.

**Phase 2 — sharing on (same window, minutes later).**

5. Set `DOC_SHARING_ENABLED=true` in `apps/api/.env`, reload PHP-FPM
   (`/etc/init.d/php-fpm-84 reload`), and re-run `php bin/doc-sharing-check.php`
   (`flag=on`).
6. Push **C2**. Confirm the patient and doctor Cloudflare Pages builds ran for
   that commit and the **live bundles** contain the new code (a push can
   silently get no build — check the deployed JS, not just the check-run).
7. Run `php bin/prod-migrate.php --run` again: step 12 sends the one-time
   notices (`documents_private_notice: sent`, `documents_private_doctor_notice:
   sent`; a re-run reports `already sent`). Patients with documents get "Your
   documents are now private" (those with files attached to an upcoming
   consultation get the variant that links to it); active doctor logins get
   "Patients now choose what you see". No share is ever created.
8. Rollback, if needed — every path lands on private code:
   - a front-end problem → revert **C2** (the API stays private by default);
   - a sharing problem → set `DOC_SHARING_ENABLED=false` and reload PHP-FPM:
     doctors see nothing, patients see "Sharing is unavailable right now. Your
     documents stay private.", and their existing shares come back when it is
     switched on again.

`bin/send-reminders.php` (the existing 5-minute cron) now also records expired
shares and closes doctors' requests after 7 days (its log line `document
access: …` ends with the `active_grants` / `pending_requests` totals). No new
cron. Doctor requests email the patient (naming the doctor only) when their
email notifications are on; preview it with `php bin/preview-email.php`.

### One-time: the clock fix (appointment times) — then switching on the cron

**What was wrong.** This box runs PHP with `date.timezone = PRC` (UTC+8, the
aaPanel default) in both PHP-FPM and the CLI, and every timestamp column is
stored without a zone, on that clock. The apps send booking times as UTC
instants (`…+00:00` / `…Z`). Patient and back-office bookings, both
reschedules and the doctor's availability editor stored them **without
converting**: 10:00 UTC was stored as `10:00` and read back as 10:00 PRC
(02:00 UTC). So those bookings and every published availability slot read
**8 hours early** — in the apps, the call window, reminders, the
past-appointment closer and the double-booking check (the 2026-09-16 09:00
double booking came from this). Doctor follow-up proposals were always
converted and are right. Locally PHP runs on UTC, which is why tests never
showed it.

**What this release does.** The server stays on PRC — switching it to UTC would
shift every other stored time (created_at, expiries, ledgers, audit, sessions).
Instead:

1. Every time the API stores is converted to the server's clock first, so new
   bookings, reschedules, proposals and availability slots are right from the
   PHP reload on.
2. Two nullable columns mark what the new code wrote:
   `appointments.scheduled_epoch` and `availability_slots.starts_epoch`
   (BIGINT; the redeploy one-liner adds them — nothing dropped or retyped).
3. **`prod-migrate` step 13** moves the rows stored on the wrong clock (+8 h;
   the document shares that follow those consultations move with them) — **only
   when run with `--fix-clock`**, after you have reviewed it. Until then
   **scheduling is paused**: booking, rescheduling, follow-up proposals and
   acceptances, booking checkouts and the doctor's availability edits answer
   `503` "Scheduling is paused for a few minutes…"; everything else works.
   `/health/ready` shows `"clock":{"marker":true,"repair":"pending"}`.
4. Emails and in-app notices give times on the clinic's clock with the zone
   ("10:00 AM WAT"); certificates and referrals print the consultation date on
   the clinic's calendar.
5. `bin/send-reminders.php` is safer for its first run: it runs no job at all
   until step 13 has been recorded (`clock repair pending … no jobs run`), one
   failing job no longer stops the others, follow-up proposals that expired
   more than 3 days ago close quietly (audited, no messages), and a card
   checkout is expired only on Paystack's own answer — never because Paystack
   could not be reached.

No front-end code changes in this release. Do it outside clinic hours.
Scheduling is paused from the PHP reload in step 2 until step 4 — a few minutes
if you prepared your decisions in step 1.

**psql access** for the read-only queries below — once per shell, from
`apps/api` (it reads `.env` the way the app does; if `psql` is not on the PATH,
use its full path, e.g. `/www/server/pgsql/bin/psql`):

```bash
cd /www/wwwroot/api.dosthq.com/supadoc/apps/api && eval "$(php -r 'require "vendor/autoload.php"; Dotenv\Dotenv::createImmutable(".")->safeLoad(); foreach (["PGHOST" => ["DB_HOST", "127.0.0.1"], "PGPORT" => ["DB_PORT", "5432"], "PGDATABASE" => ["DB_NAME", "videomed"], "PGUSER" => ["DB_USER", "videomed"], "PGPASSWORD" => ["DB_PASSWORD", ""]] as $pg => [$key, $default]) { echo "export ", $pg, "=", escapeshellarg(trim((string) ($_ENV[$key] ?? $default))), "\n"; }')"
```

(`unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD` when done.)

**1. Before deploying — read-only preview (changes nothing).** Push first (the
API only changes when you run the one-liner, and this release changes no
front-end code), then on the API box:

```bash
cd /www/wwwroot/api.dosthq.com/supadoc && git fetch origin main && git show origin/main:apps/api/resources/sql/clock-repair-preview.sql > /tmp/clock-repair-preview.sql && cd apps/api && psql -X -v off=28800 -f /tmp/clock-repair-preview.sql > /tmp/clock-repair-preview.txt 2>&1; echo "psql exit=$?"; less /tmp/clock-repair-preview.txt
```

It runs in a read-only transaction that is rolled back, and prints ids, statuses
and times only. Read it:

- **Section 0** — the offsets PHP wrote into stored ISO times. Every
  `appointments.guests[]` and `audit_events` row must say `+08:00`; anything
  else means PHP did not always run on PRC — stop and ask engineering. (The
  `app_settings` rows are written by the command line and are only shown.)
- **Sections 1–2** — every appointment's class. `shift:*` moves +8 h (stored
  on the wrong clock), `keep:*` stays (doctor proposals, already right),
  `review:*` needs your decision. `on_published_slot = t` means the patient
  booked a slot the doctor published that was itself offered 8 h early: decide
  `shift` (the time the patient picked, as they saw it), `slot` (the doctor's
  published time — 16 h after today's stored value) or `keep`.
  `paid_slot_on_process_clock` on a `shift` row also needs a look.
- **Section 3** — start hours now and after the repair.
- **Section 4** — double bookings with the same start, now vs after: expect the
  2026-09-16 pair and nothing new. It does not show bookings that overlap with
  different starts, open follow-up proposals that would sit on a booked time,
  or bookings inside a doctor's block — the step's own output lists those
  (step 2's report, then the dry run in step 3).
- **Sections 5–6** — values worked out from the wrong time (document shares,
  follow-up prices, open proposals, refunds) — for information; the repair
  moves the shares that are still open and reports the rest.

Write down `ID:shift`, `ID:keep` or `ID:slot` for every `review` and
published-slot row; you pass them in steps 3–4.

**2. Deploy.** Run the redeploy one-liner as usual. Its `prod-migrate` output
has `clock_repair` with `"status": "pending"` and the same rows (a plain run
changes nothing and records nothing — `"would_record"` if nothing is on the
wrong clock; step 4 must still run) and ends with "Clock repair (step 13) …".
Read its `refusals`, `new_collisions` and `hold_collisions`: they are what
step 3 will refuse (see there). After the PHP reload:

```bash
curl -s https://api.dosthq.com/health/ready; echo
```

Expect `"tz":"PRC"` and `"clock":{"marker":true,"repair":"pending"}`. Until
step 4 the doctor's Availability page shows the not-yet-repaired slots 8 h
early; step 4 corrects them. If `marker` is `false`, PHP-FPM is using cached
old entity mappings, or the two new columns were never added (the schema
update read the old mappings) — clear the cache, check the schema and reload
(**never run step 3 or 4, and never use `CLOCK_REPAIR_GATE=off`, while marker
is false**):

```bash
cd /www/wwwroot/api.dosthq.com/supadoc/apps/api && rm -rf var/cache/doctrine* && php bin/doctrine.php orm:schema-tool:update --dump-sql && php bin/doctrine.php orm:generate-proxies && chown -R www:www var && /etc/init.d/php-fpm-84 reload && sleep 2 && curl -s https://api.dosthq.com/health/ready; echo
```

The schema line must report "Nothing to update". If it prints
`ALTER TABLE appointments ADD scheduled_epoch …` or
`ALTER TABLE availability_slots ADD starts_epoch …` instead, run the redeploy
one-liner again (it adds them now that the cache is clear) and repeat this
check until `marker` is `true`.

**3. Dry run.** Put your decisions from step 1 in `DECIDE` (comma-separated;
leave it empty if there are none), then:

```bash
DECIDE='--clock-decide=<id>:<shift|keep|slot>,<id>:<shift|keep|slot>'
cd /www/wwwroot/api.dosthq.com/supadoc/apps/api && FPM_TZ="$(curl -s https://api.dosthq.com/health/ready | php -r '$h = json_decode(stream_get_contents(STDIN)); echo (($h->clock->marker ?? false) === true) ? (string) $h->tz : "";')" && if [ -z "$FPM_TZ" ]; then echo 'STOP: /health/ready does not show "marker":true (see step 2)'; else php bin/prod-migrate.php --dry-run --fix-clock="$FPM_TZ" $DECIDE > /tmp/clock-repair-dry.txt; echo "exit=$?"; less /tmp/clock-repair-dry.txt; fi
```

(`DECIDE=''` when there is nothing to decide.) It makes every change inside a
transaction and rolls it back: expect `exit=0` and `clock_repair.status` =
`would_repair` (`would_record` if nothing is on the wrong clock), with the rows
of the preview. It refuses — exit 1, nothing changed, the reason under
`clock_repair.refusals` — when:

- a row still needs a decision (`undecided`), or a decision doesn't fit
  (`bad_decision`);
- the corrected times would make two live bookings of one doctor overlap that
  did not overlap before (`new_collision`, listed under `new_collisions` — a
  real double booking the offset hid): cancel one in the back office first;
- an open follow-up proposal would sit on a booked time, or on another open
  proposal (`hold_collision`, listed under `hold_collisions` — accepting it
  would double-book): the doctor withdraws it, or cancel it in the back office;
- the CLI's mappings or the database lack the new columns (`marker_unmapped` —
  see step 2), the CLI's zone differs from PHP-FPM's (`zone_mismatch`), PHP
  wrote other offsets in the past (`zone_history`), the zone has daylight
  saving (`zone_has_transitions`), or a repair was recorded for another zone
  (`recorded_for_other_zone`).

Cancelling and withdrawing still work while scheduling is paused. Then run the
dry run again. `busy` means the tables stayed locked by other work for 10 s,
or Postgres broke a lock cycle between the repair and a request — run it
again. Also read, for after step 4: `live_overlaps_after` (live bookings of one
doctor that already overlapped — see step 6), `blocked_after` (upcoming
bookings inside the doctor's own block — see step 6), `grants_expired_early`
(document shares that ended early because of the wrong time — the patient can
share again), `money_review` and `follow_up_pricing_review`.

**4. The repair.** The same command with `--run` instead of `--dry-run`:

```bash
cd /www/wwwroot/api.dosthq.com/supadoc/apps/api && FPM_TZ="$(curl -s https://api.dosthq.com/health/ready | php -r '$h = json_decode(stream_get_contents(STDIN)); echo (($h->clock->marker ?? false) === true) ? (string) $h->tz : "";')" && if [ -z "$FPM_TZ" ]; then echo 'STOP: /health/ready does not show "marker":true (see step 2)'; else php bin/prod-migrate.php --run --fix-clock="$FPM_TZ" $DECIDE > /tmp/clock-repair-run.txt; echo "exit=$?"; less /tmp/clock-repair-run.txt; fi
```

Expect `exit=0` and `"status": "repaired"` (`"recorded"` if nothing was on the
wrong clock); `/health/ready` now shows `"repair":"done"` and scheduling works
again. Every change is in the audit log (`appointment.time_corrected`,
`availability.time_corrected`, `document_access.expiry_corrected`, one
`maintenance.clock_repaired`) with its old and new time. Running it again —
with the same `$DECIDE` or with `DECIDE=''` — is safe: it reports `done` and
changes nothing (a decision on a row the repair already corrected is ignored).

If a later `prod-migrate` reports `stragglers`, rows were written on the wrong
clock after the recorded repair (an old PHP-FPM worker during the deploy, or a
marker that disagrees with its time). Scheduling is not paused. The rows are
listed under `clock_repair.review`: decide each as in step 1 and run steps 3
and 4 again with those decisions.

**5. Verify** (read-only; with the psql access above):

```bash
psql -X <<'SQL'
-- every row marked, and the marker agrees with the stored time (expect 0 | 0, twice)
SELECT count(*) FILTER (WHERE scheduled_epoch IS NULL) AS unmarked,
       count(*) FILTER (WHERE scheduled_epoch <> extract(epoch FROM scheduled_at)::bigint - 28800) AS disagree
  FROM appointments;
SELECT count(*) FILTER (WHERE starts_epoch IS NULL) AS unmarked,
       count(*) FILTER (WHERE starts_epoch <> extract(epoch FROM starts_at)::bigint - 28800) AS disagree
  FROM availability_slots;
-- nothing starts before it was booked (expect 0, except the rows step 13 listed as
-- `review:starts_before_booked` (whatever you decided) and rows you decided `keep`)
SELECT count(*) AS starts_before_booked FROM appointments WHERE scheduled_at < created_at;
-- start hours on the clinic's clock (WAT = PRC - 7 h): clinic hours, nothing at 00-06
SELECT extract(hour FROM scheduled_at - interval '7 hours')::int AS wat_hour, count(*)
  FROM appointments GROUP BY 1 ORDER BY 1;
-- the repair is recorded and audited
SELECT value FROM app_settings WHERE setting_key = 'prod_migrate.clock_repair';
SELECT action, count(*) FROM audit_events
 WHERE action IN ('appointment.time_corrected', 'availability.time_corrected',
                  'document_access.expiry_corrected', 'maintenance.clock_repaired')
 GROUP BY 1 ORDER BY 1;
-- live bookings of one doctor that overlap: only the pairs the run listed under
-- live_overlaps_after (at least the 2026-09-16 pair, now 17:00 PRC = 10:00 WAT), until you resolve them
SELECT a.specialist_id, a.id AS first_id, b.id AS second_id,
       to_char(a.scheduled_at - interval '7 hours', 'YYYY-MM-DD HH24:MI') AS first_wat,
       to_char(b.scheduled_at - interval '7 hours', 'YYYY-MM-DD HH24:MI') AS second_wat
  FROM appointments a
  JOIN appointments b ON b.specialist_id = a.specialist_id AND a.id < b.id
  JOIN specialists s ON s.id = a.specialist_id
 WHERE a.status IN ('pending', 'confirmed', 'rescheduled') AND a.deleted_at IS NULL
   AND b.status IN ('pending', 'confirmed', 'rescheduled') AND b.deleted_at IS NULL
   AND a.scheduled_at < b.scheduled_at + (s.slot_minutes || ' minutes')::interval
   AND b.scheduled_at < a.scheduled_at + (s.slot_minutes || ' minutes')::interval
 ORDER BY a.scheduled_at;
-- upcoming consultations on the clinic's clock: compare with what was booked
SELECT id, status, to_char(scheduled_at - interval '7 hours', 'YYYY-MM-DD HH24:MI') AS wat
  FROM appointments
 WHERE deleted_at IS NULL AND status IN ('pending', 'confirmed', 'rescheduled', 'proposed')
   AND scheduled_at > (now() AT TIME ZONE 'UTC') + interval '8 hours'
 ORDER BY scheduled_at;
SQL
```

Then in the apps: an upcoming consultation shows the time that was booked; the
doctor's Availability page shows published slots at the times the doctor
entered; a test booking made by staff shows the right time and its email says
"… WAT".

**6. Overlapping bookings and bookings inside a block.** The repair moves
bookings that already overlapped together, so they still overlap: the run
listed them under `live_overlaps_after` — at least the 2026-09-16 pair (two
confirmed bookings, one doctor, same start). It listed upcoming bookings that
fall inside the doctor's own block under `blocked_after` (the old check applied
blocks 8 h off). Resolve each with the doctor: cancel and refund one booking in
the back office, or let the doctor move it. Then run
`php bin/prod-migrate.php --run`: once no two live bookings share a start, step
10 reports `uniq_appointments_live_slot: created`.

**Rolling back.** Before step 4 nothing has changed: to back out, check out the
previous commit and reload PHP-FPM (`git checkout 0ee2057`, `composer install
--no-dev --optimize-autoloader`, `rm -rf var/cache/doctrine*`,
`php bin/doctrine.php orm:generate-proxies`, `chown -R www:www var`, reload) —
leave the two new columns (the old code ignores them; don't run
`schema-tool:update` on the old commit). **After step 4, never roll back**: the
old code would store new bookings 8 h wrong again — fix forward.

**Stuck before step 4?** Only as a stop-gap, and **only while `/health/ready`
shows `"marker":true`**: `CLOCK_REPAIR_GATE=off` in `.env` plus a PHP-FPM
reload lifts the scheduling pause. New bookings are then stored right, but the
not-yet-repaired ones still read 8 h early and the double-booking check can't
see them at their real time. (With `"marker":false`, new bookings would be
stored without the marker and step 13 would later move them 8 h wrong.) The
cron still refuses to run. Remove the line (and reload) once step 4 has run.

**Never change `date.timezone`** on this box (PHP-FPM or CLI) without converting
every timestamp column at the same moment. After such a change — to UTC too,
including a lost `date.timezone` line (PHP then falls back to UTC) — the API
pauses scheduling (`"repair":"pending"`), the cron refuses to run and step 13
refuses (`recorded_for_other_zone`) until engineering has dealt with it. If
only one side changed (the CLI no longer matches PHP-FPM), that side stops:
the cron and step 13 for the CLI, scheduling for PHP-FPM.

#### Switching on the cron (`bin/send-reminders.php`) — only after step 5 is clean

The 5-minute cron has never run on this box. It refuses to run any job (exit 1,
`clock repair pending (prod-migrate step 13): no jobs run` on stderr) until
`/health/ready` shows `"repair":"done"`. Its first run then works through
everything that piled up — join reminders, closing past consultations (with
refunds), expiring follow-up proposals, doctors' licence reminders and
**suspensions**, card-payment checks and wallet credits, prescription expiry,
document-sharing bookkeeping. Look first (read-only, with the psql access
above):

```bash
psql -X <<'SQL'
-- past consultations the closer will close (started over 3 days ago = closed quietly, no messages;
-- refunds follow Booking settings — a patient no-show refunds 0 %)
SELECT a.id, a.status, a.payment_status, to_char(a.scheduled_at - interval '7 hours', 'YYYY-MM-DD HH24:MI') AS wat,
       a.scheduled_at < (now() AT TIME ZONE 'UTC') + interval '8 hours' - interval '3 days' AS closes_quietly
  FROM appointments a JOIN specialists s ON s.id = a.specialist_id
 WHERE a.deleted_at IS NULL AND a.status IN ('pending', 'rescheduled', 'confirmed')
   AND a.scheduled_at + (s.slot_minutes || ' minutes')::interval < (now() AT TIME ZONE 'UTC') + interval '8 hours'
 ORDER BY a.scheduled_at;
-- follow-up proposals past their expiry (expired over 3 days ago = closed quietly)
SELECT id, to_char(expires_at - interval '7 hours', 'YYYY-MM-DD HH24:MI') AS expired_wat,
       expires_at < (now() AT TIME ZONE 'UTC') + interval '8 hours' - interval '3 days' AS closes_quietly
  FROM appointments
 WHERE status = 'proposed' AND deleted_at IS NULL AND expires_at <= (now() AT TIME ZONE 'UTC') + interval '8 hours'
 ORDER BY expires_at;
-- LICENCES: approved doctors whose verified practising licence has expired with no current one
-- (suspended on the first run, their upcoming bookings cancelled and refunded)
SELECT c.specialist_id, c.expires_at
  FROM specialist_credentials c JOIN specialists s ON s.id = c.specialist_id
 WHERE c.type = 'annual_practising_licence' AND c.status = 'verified' AND c.expires_at < CURRENT_DATE
   AND s.status = 'approved' AND s.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM specialist_credentials o
                    WHERE o.specialist_id = c.specialist_id AND o.type = c.type
                      AND o.status = 'verified' AND o.expires_at >= CURRENT_DATE)
 ORDER BY c.expires_at;
-- card checkouts the sweep will look at (initiated: asked again; paid and unused for 30 min: credited to the wallet)
SELECT status, count(*) FROM payment_intents WHERE status IN ('initiated', 'paid') GROUP BY 1;
SQL
```

- Past consultations you want handled differently: resolve them in the back
  office first (mark held / cancel with refund).
- **Licences:** a doctor listed there is **suspended automatically** on the
  first run (`LICENCE_GRACE_DAYS` in `.env`, default `0`, is the grace after
  expiry) and their upcoming bookings are cancelled and refunded. If that isn't
  intended, record the renewed licence in the back office, or set
  `LICENCE_GRACE_DAYS=<days>` in `.env`, before the first run.
- **Paystack** must be reachable with the right key (as the web user):

  ```bash
  cd /www/wwwroot/api.dosthq.com/supadoc/apps/api && runuser -u www -- php -r 'require "vendor/autoload.php"; Dotenv\Dotenv::createImmutable(".")->safeLoad(); $base = rtrim(trim((string) ($_ENV["PAYSTACK_BASE_URL"] ?? "")) ?: "https://api.paystack.co", "/"); $ch = curl_init($base . "/transaction/verify/vma_reachability_check"); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => ["Authorization: Bearer " . trim((string) ($_ENV["PAYSTACK_SECRET_KEY"] ?? ""))], CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 8]); curl_exec($ch); echo "curl=", curl_errno($ch), " http=", curl_getinfo($ch, CURLINFO_HTTP_CODE), PHP_EOL;'
  ```

  `curl=0 http=400` (or `404`) is right: Paystack answered, accepted the key and
  doesn't know that made-up reference. `http=401` = wrong key or the other mode
  (test/live); `curl` other than `0` = the box can't reach Paystack (see
  `php bin/paystack-check.php`). Nothing is created at Paystack. (While Paystack
  can't be reached the sweep now leaves checkouts open — nothing is expired —
  but nothing gets credited either.)

Then, in this order:

1. The log folder, owned by the web user, and the CLI on PHP-FPM's zone:

   ```bash
   cd /www/wwwroot/api.dosthq.com/supadoc/apps/api && mkdir -p var/log && chown -R www:www var && runuser -u www -- sh -c 'command -v php' && runuser -u www -- php bin/doc-sharing-check.php --expect-tz="$(curl -s https://api.dosthq.com/health/ready | php -r 'echo json_decode(stream_get_contents(STDIN))->tz;')"
   ```

   Expect a php path (e.g. `/usr/bin/php`) and `tz_check=ok`.
2. **One manual run** as the web user, with the same lock the cron uses, into
   the same log:

   ```bash
   cd /www/wwwroot/api.dosthq.com/supadoc/apps/api && runuser -u www -- sh -c 'flock -n var/send-reminders.lock php bin/send-reminders.php 2>&1 | tee -a var/log/reminders.log'
   ```

   If it prints `clock repair pending (prod-migrate step 13): no jobs run`, step
   4 has not run on this database — go back. Otherwise read every line:
   `reminders: … sent=`, `prescriptions: …`, `consultations: … errors=0`,
   `follow-ups: expired=… nudged=…`, `licences: … suspended=` (0 unless you
   expected one), `card payments: … errors=0`, `document access: … errors=0`.
   Any `errors=` above 0 or any other stderr line: stop and read
   `var/logs/app.log` and the PHP error log before going on.
3. **Install the cron** in the web user's crontab (it stops if www already has
   one — then add the two lines by hand with `crontab -u www -e`); the `HOME`
   line gives cron a working directory www can enter:

   ```bash
   crontab -u www -l 2>/dev/null && echo 'STOP: www already has a crontab - add the two lines by hand (crontab -u www -e)' || printf '%s\n' 'HOME=/www/wwwroot/api.dosthq.com/supadoc/apps/api' '*/5 * * * * cd /www/wwwroot/api.dosthq.com/supadoc/apps/api && flock -n var/send-reminders.lock php bin/send-reminders.php >> var/log/reminders.log 2>&1' | crontab -u www - && crontab -u www -l
   ```

   If step 1 printed a php path other than `/usr/bin/php` or `/bin/php`, use that
   full path instead of `php` in the line. `flock -n` skips a run while the last
   one is still going. Don't also add it in aaPanel's Cron page (that runs as
   root). Ten minutes later `tail -n 20 var/log/reminders.log` shows two more
   runs.

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
| Doctors see no patient documents | Expected unless the patient shared them (documents are private by default). With `DOC_SHARING_ENABLED` off nobody can share; `php bin/doc-sharing-check.php` shows the flag and totals. |
| Patients see "Sharing is unavailable right now" | `DOC_SHARING_ENABLED` is off (or not `true`/`1`) in `apps/api/.env` — set it and reload PHP-FPM. |
| `doc-sharing-check` exits 1 (`tz_check=MISMATCH`) | The CLI and PHP-FPM run in different time zones; set the same `date.timezone` in both php.ini files before running cron / prod-migrate. |
| Hard-deleting a patient or doctor fails on a foreign key | Their document-sharing records (`document_access_grants` / `_requests`) reference them (`RESTRICT`) and are medical-record retention data: export and purge them under the retention policy first, never by cascade. |
| Booking, rescheduling or availability edits answer `503` "Scheduling is paused…" | The clock repair (prod-migrate step 13) hasn't run on this database, or `date.timezone` changed since it ran (to UTC too) — `/health/ready` shows `"repair":"pending"`. See "One-time: the clock fix". |
| `/health/ready` shows `"marker":false` | PHP-FPM uses stale entity mappings, or the two clock-fix columns are missing: run step 2's remedy in "One-time: the clock fix" (`orm:schema-tool:update --dump-sql` must report "Nothing to update"). |
| `var/log/reminders.log` says `clock repair pending (prod-migrate step 13): no jobs run` | The clock repair hasn't run on this database, or `date.timezone` changed — see "One-time: the clock fix". The cron runs its jobs again by itself once `/health/ready` shows `"repair":"done"`. |
| Appointment or availability times 8 hours early | Rows still on the wrong clock (or `date.timezone` was changed) — see "One-time: the clock fix". |
