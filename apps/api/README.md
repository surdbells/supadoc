# VideoMed API

Backend for the VideoMed patient platform. **Slim 4 · PHP-DI · Doctrine ORM 3 ·
PostgreSQL**, following the architecture in
[`BACKEND-ARCHITECTURE.md`](../../BACKEND-ARCHITECTURE.md).

> This is a **scaffold**: the reusable core (config, middleware, persistence,
> auth, response envelope, base repository) plus one representative domain slice
> (Auth + Appointments). Add further domains by copying the same shape:
> **Action = HTTP, Service = behaviour, Repository = queries, Entity = state.**

## Layout

```
apps/api/
├── public/index.php         # single entry point
├── config/                  # container, middleware, routes, cli, migrations, sentry
├── src/
│   ├── Action/              # one class per endpoint (autowired)
│   ├── Domain/{Entity,Repository,Enum,Exception}
│   └── Infrastructure/{Middleware,Persistence,Service}
├── bin/doctrine.php         # Doctrine ORM CLI
├── bin/seed.php             # idempotent dev seed
├── docker-compose.yml       # local Postgres + Redis
├── migrations/              # real migrations (day one)
└── tests/Unit/              # offline DQL + mapping + container checks
```

## Setup

```bash
cd apps/api
composer install
cp .env.example .env            # fill DB_*, JWT_SECRET (>=32 bytes), REDIS_*, CORS_*
```

Bring up dependencies (Postgres + Redis on offset host ports 5544 / 6399 —
`.env` already points there):

```bash
docker compose up -d
```

Create the schema (dev) or generate a migration (preferred):

```bash
php bin/doctrine.php orm:schema-tool:create          # fresh dev DB
composer schema:preview                              # dump SQL, no changes
composer schema:apply                                # apply diff directly (dev only)
# — or —
vendor/bin/doctrine-migrations diff                  # generate a migration
vendor/bin/doctrine-migrations migrate               # apply it
```

Run:

```bash
composer start                  # php -S localhost:8080 -t public
curl localhost:8080/health
```

## Seed & try it

```bash
php bin/seed.php                # admin@ / viewer@ / patient@videomed.test, pw: password123
```

```bash
# staff sign-in -> access_token
curl -s localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@videomed.test","password":"password123"}'

# customer (patient) sign-in -> customer-scoped token
curl -s localhost:8080/api/portal/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"patient@videomed.test","password":"password123"}'
```

`viewer@` has `appointments.view` only, so it 403s on `POST /api/appointments` —
handy for checking RBAC. A staff token is rejected by `/api/portal/*` and vice
versa (audience `scope`).

## Tests

Fast, no database required (see ARCHITECTURE §12): DQL compiles offline, mapping
is validated, and the DI container is asserted to resolve.

```bash
composer test
```

## Conventions (the ones that bite)

- **Money is `decimal` mapped to `string`** — never float.
- **`toArray()` on the entity** is the serialisation boundary; Actions never
  hand-roll JSON.
- **One response envelope** for the whole API (`App\Infrastructure\Service\ApiResponse`):
  `{ status, message, data, meta?, errors? }`.
- **JWT carries an audience `scope`**; staff/customer/investor middleware reject
  tokens minted for a different audience. Permission changes take effect at next
  sign-in (they ride in the token).
- **RBAC**: `new RbacMiddleware(['a', 'b'])` = ANY; `requireAll: true` = ALL.
  `super_admin` bypasses.
- **PostgreSQL `=` is case-sensitive** — normalise + validate against the enum at
  the edge; date ranges need `... 23:59:59`.
- **Middleware is LIFO** — CORS added last so it runs first and survives errors.
