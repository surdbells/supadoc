import {
  HttpClient,
  HttpHeaders,
  type HttpInterceptorFn,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import {
  type EnvironmentProviders,
  type Provider,
  type Type,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  httpErrorInterceptor,
  LOGGER,
  provideSupadocDataAccess,
} from '@supadoc/data-access';
import type { ApiError } from '@supadoc/models';
import { refreshInterceptor } from '../auth-refresh.interceptor';
import { AuthService } from '../auth.service';
import { provideStaffAuth } from '../provide-staff-auth';
import { staffAuthInterceptor } from '../staff-auth.interceptor';
import { StaffAuthService } from '../staff-auth.service';
import type { TokenSession } from './session-auth';
import { REFRESH_UNAVAILABLE_MESSAGE } from './session-http';
import {
  SESSION_TIMEOUT_CONFIG,
  SessionTimeoutService,
} from './session-timeout.service';
import { RELOAD_PAGE } from './session-utils';
import { tokenFor } from './testing';

const BASE = 'https://api.test';

interface Silo {
  name: string;
  tokenKey: string;
  refreshKey: string;
  interceptor: HttpInterceptorFn;
  service: Type<TokenSession>;
  providers: Array<Provider | EnvironmentProviders>;
}

const SILOS: Silo[] = [
  {
    name: 'staff (doctor / back office)',
    tokenKey: 'test.staff.token',
    refreshKey: 'test.staff.token.refresh',
    interceptor: staffAuthInterceptor,
    service: StaffAuthService,
    providers: [provideStaffAuth({ storageKey: 'test.staff.token' })],
  },
  {
    name: 'patient',
    tokenKey: 'videomed.token',
    refreshKey: 'videomed.refresh',
    interceptor: refreshInterceptor,
    service: AuthService,
    providers: [],
  },
];

/** Let promise chains (the pre-flight, the refresh) settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const isRefresh = (r: { url: string }) => r.url === `${BASE}/api/auth/refresh`;
const isLogout = (r: { url: string }) => r.url === `${BASE}/api/auth/logout`;
const bearer = (req: TestRequest) => req.request.headers.get('Authorization');

function unauthorized(
  code: string | null,
  message = 'Invalid or expired token',
) {
  return {
    status: 401,
    statusText: 'Unauthorized',
    body: {
      status: 'error',
      message,
      ...(code ? { errors: { auth: message, code } } : {}),
    },
  };
}

for (const silo of SILOS) {
  describe(`handleSessionRequest — ${silo.name}`, () => {
    function setup(
      opts: {
        access?: string;
        refresh?: string | null;
        timeout?: boolean;
      } = {},
    ) {
      localStorage.clear();
      sessionStorage.clear();
      if (opts.access) localStorage.setItem(silo.tokenKey, opts.access);
      if (opts.refresh !== null)
        localStorage.setItem(silo.refreshKey, opts.refresh ?? 'R1');
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const hold = vi.fn();
      const release = vi.fn();
      TestBed.configureTestingModule({
        providers: [
          provideHttpClient(
            withInterceptors([httpErrorInterceptor, silo.interceptor]),
          ),
          provideHttpClientTesting(),
          provideSupadocDataAccess({ baseUrl: BASE }),
          ...silo.providers,
          { provide: LOGGER, useValue: logger },
          { provide: RELOAD_PAGE, useValue: vi.fn() },
          ...(opts.timeout
            ? [
                {
                  provide: SESSION_TIMEOUT_CONFIG,
                  useValue: { idleMinutes: 15 },
                },
                { provide: SessionTimeoutService, useValue: { hold, release } },
              ]
            : []),
        ],
      });
      const http = TestBed.inject(HttpClient);
      const ctl = TestBed.inject(HttpTestingController);
      const auth = TestBed.inject(silo.service);
      return { http, ctl, auth, logger, hold, release };
    }

    afterEach(() => {
      vi.useRealTimers();
      localStorage.clear();
      sessionStorage.clear();
    });

    it('sends a fresh token as it is: no refresh, nothing logged', async () => {
      const A = tokenFor('u1', 900);
      const { http, ctl, logger } = setup({ access: A });
      let done = false;
      http.get(`${BASE}/api/x`).subscribe(() => (done = true));
      await settle();
      const req = ctl.expectOne(`${BASE}/api/x`);
      expect(bearer(req)).toBe(`Bearer ${A}`);
      req.flush({});
      expect(done).toBe(true);
      expect(ctl.match(isRefresh)).toHaveLength(0);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      ctl.verify();
    });

    it('refreshes a token about to expire ONCE before parallel requests, which all leave with the new one', async () => {
      const A = tokenFor('u1', 30);
      const B = tokenFor('u1', 900);
      const { http, ctl, logger } = setup({ access: A });
      for (let i = 0; i < 5; i++) http.get(`${BASE}/api/x${i}`).subscribe();
      await settle();
      // Nothing left yet: they wait for the refresh.
      expect(ctl.match((r) => r.url.startsWith(`${BASE}/api/x`))).toHaveLength(
        0,
      );
      const refreshes = ctl.match(isRefresh);
      expect(refreshes).toHaveLength(1);
      expect(refreshes[0].request.body).toEqual({ refresh_token: 'R1' });
      refreshes[0].flush({ data: { access_token: B } });
      await settle();
      for (let i = 0; i < 5; i++) {
        const req = ctl.expectOne(`${BASE}/api/x${i}`);
        expect(bearer(req)).toBe(`Bearer ${B}`);
        req.flush({});
      }
      expect(logger.error).not.toHaveBeenCalled();
      ctl.verify();
    });

    it('never makes the refresh request wait for a refresh (no deadlock with an expired token)', async () => {
      const { ctl, auth } = setup({ access: tokenFor('u1', -10) });
      const result = auth.refresh();
      await settle();
      ctl
        .expectOne(isRefresh)
        .flush({ data: { access_token: tokenFor('u1', 900) } });
      await expect(result).resolves.toBe(true);
      ctl.verify();
    });

    it('a 401 token_expired (a race): one refresh, one retry, and nothing logged', async () => {
      const A = tokenFor('u1', 900);
      const B = tokenFor('u1', 900, { n: 2 });
      const { http, ctl, logger } = setup({ access: A });
      let body: unknown;
      http.get(`${BASE}/api/x`).subscribe((b) => (body = b));
      await settle();
      const first = ctl.expectOne(`${BASE}/api/x`);
      const r = unauthorized('token_expired');
      first.flush(r.body, r);
      await settle();
      ctl.expectOne(isRefresh).flush({ data: { access_token: B } });
      await settle();
      const retry = ctl.expectOne(`${BASE}/api/x`);
      expect(bearer(retry)).toBe(`Bearer ${B}`);
      retry.flush({ ok: true });
      expect(body).toEqual({ ok: true });
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      ctl.verify();
    });

    it('a 401 without a code (an API without codes): refresh + retry, as before', async () => {
      const { http, ctl } = setup({ access: tokenFor('u1', 900) });
      let ok = false;
      http.get(`${BASE}/api/x`).subscribe(() => (ok = true));
      await settle();
      const r = unauthorized(null);
      ctl.expectOne(`${BASE}/api/x`).flush(r.body, r);
      await settle();
      ctl
        .expectOne(isRefresh)
        .flush({ data: { access_token: tokenFor('u1', 900, { n: 2 }) } });
      await settle();
      ctl.expectOne(`${BASE}/api/x`).flush({});
      expect(ok).toBe(true);
      ctl.verify();
    });

    it('a 401 session_revoked ends the session at once with the server message — no refresh', async () => {
      const { http, ctl, auth, logger } = setup({
        access: tokenFor('u1', 900),
      });
      const expire = vi.spyOn(auth, 'expire');
      let error: ApiError | undefined;
      http
        .get(`${BASE}/api/x`)
        .subscribe({ error: (e: ApiError) => (error = e) });
      await settle();
      const r = unauthorized(
        'session_revoked',
        'This session has been signed out',
      );
      ctl.expectOne(`${BASE}/api/x`).flush(r.body, r);
      await settle();
      expect(ctl.match(isRefresh)).toHaveLength(0);
      expect(expire).toHaveBeenCalledTimes(1);
      expect(expire).toHaveBeenCalledWith(
        'revoked',
        'This session has been signed out',
      );
      expect(auth.isAuthenticated()).toBe(false);
      expect(error?.statusCode).toBe(401);
      expect(error?.message).toBe('This session has been signed out');
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
      ctl.match(isLogout).forEach((req) => req.flush({}));
      ctl.verify();
    });

    it('a 401 token_wrong_audience is passed on: no refresh, no sign-out, logged as an error', async () => {
      const { http, ctl, auth, logger } = setup({
        access: tokenFor('u1', 900),
      });
      const expire = vi.spyOn(auth, 'expire');
      let failed = false;
      http.get(`${BASE}/api/x`).subscribe({ error: () => (failed = true) });
      await settle();
      const r = unauthorized(
        'token_wrong_audience',
        'This token is not valid here',
      );
      ctl.expectOne(`${BASE}/api/x`).flush(r.body, r);
      await settle();
      expect(failed).toBe(true);
      expect(ctl.match(isRefresh)).toHaveLength(0);
      expect(expire).not.toHaveBeenCalled();
      expect(auth.isAuthenticated()).toBe(true);
      expect(logger.error).toHaveBeenCalledTimes(1);
      ctl.verify();
    });

    it('a request sent with token A while a refresh to B finishes is retried with B — no second refresh', async () => {
      const A = tokenFor('u1', 900);
      const B = tokenFor('u1', 900, { n: 2 });
      const { http, ctl, auth } = setup({ access: A });
      let ok = false;
      http.get(`${BASE}/api/x`).subscribe(() => (ok = true));
      await settle();
      const first = ctl.expectOne(`${BASE}/api/x`);
      expect(bearer(first)).toBe(`Bearer ${A}`);
      // Meanwhile something else refreshed (e.g. the proactive refresh).
      const refreshed = auth.refresh();
      await settle();
      ctl.expectOne(isRefresh).flush({ data: { access_token: B } });
      await refreshed;
      const r = unauthorized('token_expired');
      first.flush(r.body, r);
      await settle();
      const retry = ctl.expectOne(`${BASE}/api/x`);
      expect(bearer(retry)).toBe(`Bearer ${B}`);
      retry.flush({});
      expect(ok).toBe(true);
      expect(ctl.match(isRefresh)).toHaveLength(0);
      ctl.verify();
    });

    it('a refresh refused for now (429, Retry-After 7): still signed in, a friendly error, and no new attempt for 7 s', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
      const { http, ctl, auth } = setup({ access: tokenFor('u1', -5) });
      let error: ApiError | undefined;
      http
        .get(`${BASE}/api/x`)
        .subscribe({ error: (e: ApiError) => (error = e) });
      await settle();
      ctl
        .expectOne(isRefresh)
        .flush(
          { status: 'error', message: 'Too many requests' },
          {
            status: 429,
            statusText: 'Too Many Requests',
            headers: new HttpHeaders({ 'Retry-After': '7' }),
          },
        );
      await settle();
      // Sent anyway (the API decides); its 401 meets the back-off, not a second refresh.
      const r = unauthorized('token_expired');
      ctl.expectOne(`${BASE}/api/x`).flush(r.body, r);
      await settle();
      expect(auth.isAuthenticated()).toBe(true);
      expect(error?.statusCode).toBe(401);
      expect(error?.message).toBe(REFRESH_UNAVAILABLE_MESSAGE);
      expect(error?.errors?.['code']).toBe('refresh_unavailable');
      expect(ctl.match(isRefresh)).toHaveLength(0);

      // Within the 7 s: no refresh at all.
      vi.setSystemTime(new Date('2026-10-20T10:00:05Z'));
      http.get(`${BASE}/api/y`).subscribe({ error: () => undefined });
      await settle();
      ctl.expectOne(`${BASE}/api/y`).flush(r.body, r);
      await settle();
      expect(ctl.match(isRefresh)).toHaveLength(0);

      // After it: refreshed before the request, which then succeeds.
      vi.setSystemTime(new Date('2026-10-20T10:00:08Z'));
      const B = tokenFor('u1', 900);
      let ok = false;
      http.get(`${BASE}/api/z`).subscribe(() => (ok = true));
      await settle();
      ctl.expectOne(isRefresh).flush({ data: { access_token: B } });
      await settle();
      const z = ctl.expectOne(`${BASE}/api/z`);
      expect(bearer(z)).toBe(`Bearer ${B}`);
      z.flush({});
      expect(ok).toBe(true);
      ctl.verify();
    });

    it('a refresh met by a CDN / WAF 403 page never signs anyone out', async () => {
      const { ctl, auth } = setup({ access: tokenFor('u1', -5) });
      const result = auth.refresh();
      await settle();
      ctl
        .expectOne(isRefresh)
        .flush('<html>Access denied</html>', {
          status: 403,
          statusText: 'Forbidden',
        });
      await expect(result).resolves.toBe(false);
      expect(auth.isAuthenticated()).toBe(true);
      expect(auth.hasRefreshToken()).toBe(true);
      ctl.verify();
    });

    it('a refused refresh ends the session; the request fails with the sign-in notice (never the raw token error)', async () => {
      const { http, ctl, auth, logger } = setup({ access: tokenFor('u1', -5) });
      let error: ApiError | undefined;
      http
        .get(`${BASE}/api/x`)
        .subscribe({ error: (e: ApiError) => (error = e) });
      await settle();
      const r = unauthorized(
        'session_expired',
        'Your session has expired. Please sign in again.',
      );
      ctl.expectOne(isRefresh).flush(r.body, r);
      await settle();
      // The session ended while the request waited: it is never sent.
      expect(ctl.match(`${BASE}/api/x`)).toHaveLength(0);
      expect(auth.isAuthenticated()).toBe(false);
      expect(error?.statusCode).toBe(401);
      expect(error?.message).toBe(
        'Your session has expired. Please sign in again.',
      );
      expect(error?.errors?.['code']).toBe('signed_out');
      expect(logger.error).not.toHaveBeenCalled();
      ctl.match(isLogout).forEach((req) => req.flush({}));
      ctl.verify();
    });

    it('a retry that meets 401 again is not retried again (no loop)', async () => {
      const { http, ctl } = setup({ access: tokenFor('u1', 900) });
      let failed = false;
      http.get(`${BASE}/api/x`).subscribe({ error: () => (failed = true) });
      await settle();
      const r = unauthorized('token_expired');
      ctl.expectOne(`${BASE}/api/x`).flush(r.body, r);
      await settle();
      ctl
        .expectOne(isRefresh)
        .flush({ data: { access_token: tokenFor('u1', 900, { n: 2 }) } });
      await settle();
      ctl.expectOne(`${BASE}/api/x`).flush(r.body, r);
      await settle();
      expect(failed).toBe(true);
      expect(ctl.match(isRefresh)).toHaveLength(0);
      expect(ctl.match(`${BASE}/api/x`)).toHaveLength(0);
      ctl.verify();
    });

    it('a retry met by a session-ending 401 ends the session (not retried again)', async () => {
      const { http, ctl, auth } = setup({ access: tokenFor('u1', 900) });
      const expire = vi.spyOn(auth, 'expire');
      let error: ApiError | undefined;
      http
        .get(`${BASE}/api/doctor/onboarding`)
        .subscribe({ error: (e: ApiError) => (error = e) });
      await settle();
      const expired = unauthorized('token_expired');
      ctl.expectOne(`${BASE}/api/doctor/onboarding`).flush(expired.body, expired);
      await settle();
      ctl
        .expectOne(isRefresh)
        .flush({ data: { access_token: tokenFor('u1', 900, { n: 2 }) } });
      await settle();
      const revoked = unauthorized(
        'session_revoked',
        'This session has been signed out',
      );
      ctl.expectOne(`${BASE}/api/doctor/onboarding`).flush(revoked.body, revoked);
      await settle();
      expect(expire).toHaveBeenCalledTimes(1);
      expect(expire).toHaveBeenCalledWith(
        'revoked',
        'This session has been signed out',
      );
      expect(auth.isAuthenticated()).toBe(false);
      expect(error?.statusCode).toBe(401);
      expect(ctl.match(isRefresh)).toHaveLength(0);
      expect(ctl.match(`${BASE}/api/doctor/onboarding`)).toHaveLength(0);
      ctl.match(isLogout).forEach((req) => req.flush({}));
      ctl.verify();
    });

    it('an upload holds the idle timer while it runs, and starts with 10+ minutes of token life', async () => {
      const A = tokenFor('u1', 300); // 5 minutes left: too little for an upload
      const B = tokenFor('u1', 900);
      const { http, ctl, hold, release } = setup({ access: A, timeout: true });
      const form = new FormData();
      form.append('file', new Blob(['x']), 'x.pdf');
      http.post(`${BASE}/api/portal/documents`, form).subscribe();
      expect(hold).toHaveBeenCalledTimes(1);
      const key = hold.mock.calls[0][0] as string;
      expect(key).toMatch(/^upload:\d+$/);
      await settle();
      ctl.expectOne(isRefresh).flush({ data: { access_token: B } });
      await settle();
      const up = ctl.expectOne(`${BASE}/api/portal/documents`);
      expect(bearer(up)).toBe(`Bearer ${B}`);
      expect(release).not.toHaveBeenCalled();
      up.flush({});
      expect(release).toHaveBeenCalledWith(key);

      // …and released when it fails, too.
      http
        .post(`${BASE}/api/portal/documents`, form)
        .subscribe({ error: () => undefined });
      await settle();
      ctl
        .expectOne(`${BASE}/api/portal/documents`)
        .flush(
          { message: 'Too big' },
          { status: 413, statusText: 'Too Large' },
        );
      expect(release).toHaveBeenCalledTimes(2);
      ctl.verify();
    });

    it('public and auth URLs: no waiting for a refresh, no 401 handling', async () => {
      const { http, ctl } = setup({ access: tokenFor('u1', -5) });
      let failed = false;
      http
        .get(`${BASE}/api/public/call/abc`)
        .subscribe({ error: () => (failed = true) });
      // Sent at once — no pre-flight.
      const req = ctl.expectOne(`${BASE}/api/public/call/abc`);
      const r = unauthorized('token_expired');
      req.flush(r.body, r);
      await settle();
      expect(failed).toBe(true);
      expect(ctl.match(isRefresh)).toHaveLength(0);
      ctl.verify();
    });

    it('signed out: requests go without a token, and their 401s are passed on', async () => {
      const { http, ctl } = setup({ refresh: null });
      let failed = false;
      http
        .get(`${BASE}/api/specialists`)
        .subscribe({ error: () => (failed = true) });
      await settle();
      const req = ctl.expectOne(`${BASE}/api/specialists`);
      expect(bearer(req)).toBeNull();
      const r = unauthorized('token_missing', 'Missing bearer token');
      req.flush(r.body, r);
      await settle();
      expect(failed).toBe(true);
      expect(ctl.match(isRefresh)).toHaveLength(0);
      ctl.verify();
    });
  });
}
