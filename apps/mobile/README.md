# VideoMed mobile (Ionic)

## Sessions

Today the app only signs in, against the legacy API, which has no
`/api/auth/refresh` — so it uses the attach-only `authInterceptor` and no idle
timeout:

```ts
provideHttpClient(withInterceptors([authInterceptor, httpErrorInterceptor]));
```

When an authenticated screen is added against the VideoMed API, switch to the
same session handling as the patient portal (`apps/patient/src/app/app.config.ts`):

```ts
provideHttpClient(withInterceptors([httpErrorInterceptor, refreshInterceptor])),
provideSessionTimeout(AuthService, { idleMinutes: 15 }),
```

- `refreshInterceptor` must be the **innermost** interceptor (last in the
  list): it attaches the bearer, refreshes a token about to expire before a
  request leaves, and handles 401s (refresh + retry, or ends the session with
  the server's reason) before `httpErrorInterceptor` sees — and logs — them.
- Guard signed-in routes with `authGuard` on both `canActivate` and
  `canActivateChild`, and put `<sd-session-timeout />` in the root template.
- A screen that has no input for long stretches (a video call) holds the idle
  timer with `SessionTimeoutService.hold('call')` / `release('call')`.
