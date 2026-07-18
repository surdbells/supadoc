# Supadoc

Monorepo for the Supadoc telehealth platform. It contains four front-end
applications that share a common design system, data-access layer and auth,
all managed with [Nx](https://nx.dev).

| App          | Path              | Stack                          | Purpose                          |
| ------------ | ----------------- | ------------------------------ | -------------------------------- |
| `doctor`     | `apps/doctor`     | Angular 22 + Tailwind          | Doctor portal                    |
| `patient`    | `apps/patient`    | Angular 22 + Tailwind          | Patient portal                   |
| `backoffice` | `apps/backoffice` | Angular 22 + Tailwind          | System control center            |
| `mobile`     | `apps/mobile`     | Angular 22 + Ionic + Capacitor | Patient mobile app (iOS/Android) |

The backend API is built by a separate team and integrated as endpoints are
delivered — see [API integration](#api-integration).

## Tech stack

- **Nx 23** integrated monorepo, **pnpm** workspaces
- **Angular 22** (standalone components, signals)
- **Tailwind CSS v4** for the web apps, driven by shared design tokens
- **Ionic 8 + Capacitor 8** for the mobile app
- **Vitest** for unit tests, **ESLint** + **Prettier**

## Project structure

```
apps/
  doctor/        patient/        backoffice/     mobile/
libs/shared/
  models/        @supadoc/models        TypeScript DTOs / domain types (API contract)
  data-access/   @supadoc/data-access   HttpClient wrapper, API config, error interceptor
  auth/          @supadoc/auth          Auth service (signals), guard, token interceptor
  ui/            @supadoc/ui            Tailwind design-system components (sd-button, sd-card)
  util/          @supadoc/util          Framework-agnostic helpers
tailwind/
  theme.css      Shared Tailwind v4 design tokens (colors, type, radii)
```

Libraries are imported by their alias, e.g. `import { ApiService } from '@supadoc/data-access'`.

## Prerequisites

- **Node.js 24+**
- **pnpm 11+** (`corepack enable` will pick up the pinned version)

## Getting started

```bash
pnpm install

# Serve an app (http://localhost:4200)
pnpm start:doctor       # or: nx serve doctor
pnpm start:patient
pnpm start:backoffice
pnpm start:mobile
```

To run two apps at once, pass a different port: `nx serve patient --port 4300`.

## Common commands

```bash
pnpm build                     # build every app         (nx run-many -t build)
pnpm test                      # run every unit test
pnpm lint                      # lint everything
pnpm format                    # format with Prettier

nx build doctor                # single project
nx test shared-ui
nx affected -t build test lint # only projects touched since main
nx graph                       # visualize the project graph
```

## Design system (Tailwind)

All colors, typography and radii live in [`tailwind/theme.css`](tailwind/theme.css)
as Tailwind v4 `@theme` tokens. This is the single source of truth shared by the
three web apps — **replace the placeholder values with the finalized Figma
tokens**. Each web app's `src/styles.css` imports Tailwind, this theme file, and
`@source`s the shared UI library so its utility classes are generated.

Build shared, reusable components in `@supadoc/ui` (prefix `sd-`) so every app
stays consistent. The mobile app themes Ionic to the same palette in
[`apps/mobile/src/theme/variables.scss`](apps/mobile/src/theme/variables.scss).

**Icons** use [Lucide](https://lucide.dev/icons) via `@supadoc/ui`: register the
set with `provideSupadocIcons()` (already wired into every app) and render with
`<sd-icon name="stethoscope" [size]="18" />`. Add new icons to the curated list
in [`libs/shared/ui/src/lib/icons/icons.ts`](libs/shared/ui/src/lib/icons/icons.ts).

## Charts & data visualization

Charts and graphs must render as **SVG**, and that SVG must be **secure**:

- Prefer building charts as Angular SVG templates (`<svg>` with `<rect>`,
  `<path>`, `<text>`, …). Angular escapes interpolated bindings, so data-driven
  charts are safe by construction.
- **Never** inject chart/SVG markup via `[innerHTML]` from untrusted data, and
  **never** call `DomSanitizer.bypassSecurityTrust*` on values derived from API
  or user input.
- If a charting library is added, choose an SVG-native, Angular-friendly one
  that renders through the DOM rather than raw HTML injection (e.g. ngx-charts),
  and avoid `eval`/`Function`-based renderers.
- `<sd-icon>` already follows this: Lucide builds SVG nodes via `Renderer2`, not
  `innerHTML`.

## API integration

The API is developed separately; the integration seam is ready:

- **Base URL** per app lives in `apps/<app>/src/environments/environment.ts`
  (dev) and `environment.prod.ts` (prod, swapped in via `fileReplacements`).
- **`@supadoc/data-access`** exposes `ApiService` (a typed `HttpClient` wrapper
  that prefixes the base URL) plus `provideSupadocDataAccess({ baseUrl })`, wired
  in every app's `app.config.ts`. A shared `httpErrorInterceptor` normalizes
  errors to `ApiError`.
- **Transport/domain types** live in `@supadoc/models` (`ApiResponse<T>`,
  `Paginated<T>`, `User`, `Appointment`, ...). Align these with the real
  contract as it is published.

To add an endpoint once the API ships one, create a feature service that injects
`ApiService`:

```ts
@Injectable({ providedIn: 'root' })
export class AppointmentsService {
  private readonly api = inject(ApiService);
  list(query: PageQuery) {
    return this.api.get<Paginated<Appointment>>('appointments', query);
  }
}
```

## Auth

`@supadoc/auth` provides a signals-based `AuthService` (`token`, `user`,
`isAuthenticated`), an `authInterceptor` that attaches the bearer token, and an
`authGuard` for protected routes. `provideSupadocAuth()` is registered in each
app. Endpoint paths (`auth/login`, ...) are placeholders — adjust to the real API.

## Mobile (Ionic + Capacitor)

The mobile app is a standard Angular app using Ionic standalone components.
Native config is in [`apps/mobile/capacitor.config.ts`](apps/mobile/capacitor.config.ts)
(`webDir` points at the Nx build output).

```bash
nx build mobile                              # build the web bundle
pnpm exec cap add ios                        # add native platforms (needs Xcode / Android Studio)
pnpm exec cap add android
pnpm exec cap sync                           # copy web build + plugins into native projects
```

## Testing, lint & format

- Unit tests run on **Vitest** (`nx test <project>`). App/component tests use the
  Angular vitest builder; the mobile app inlines Ionic packages via
  `apps/mobile/vitest.config.ts` so its ESM bundles resolve under Vitest.
- Lint: `nx lint <project>`. Format: `pnpm format`.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) installs with pnpm and
runs `nx affected -t lint test build` against the changed projects on every push
and pull request.
