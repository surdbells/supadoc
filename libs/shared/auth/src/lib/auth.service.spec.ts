import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  httpErrorInterceptor,
  LOGGER,
  provideSupadocDataAccess,
} from '@supadoc/data-access';
import { refreshInterceptor } from './auth-refresh.interceptor';
import { AuthFlowService } from './auth-flow.service';
import { AuthService } from './auth.service';
import { RELOAD_PAGE } from './session/session-utils';
import { tokenFor } from './session/testing';

const BASE = 'https://api.test';
const isRefresh = (r: { url: string }) => r.url === `${BASE}/api/auth/refresh`;
const isLogout = (r: { url: string }) => r.url === `${BASE}/api/auth/logout`;
const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(
  opts: {
    access?: string;
    refresh?: string | null;
    storage?: 'local' | 'session';
  } = {},
) {
  localStorage.clear();
  sessionStorage.clear();
  const store = opts.storage === 'session' ? sessionStorage : localStorage;
  if (opts.access) store.setItem('videomed.token', opts.access);
  if (opts.refresh !== null)
    store.setItem('videomed.refresh', opts.refresh ?? 'R1');
  const reload = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(
        withInterceptors([httpErrorInterceptor, refreshInterceptor]),
      ),
      provideHttpClientTesting(),
      provideSupadocDataAccess({
        baseUrl: BASE,
        loginPath: 'api/portal/auth/login',
      }),
      {
        provide: LOGGER,
        useValue: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      { provide: RELOAD_PAGE, useValue: reload },
    ],
  });
  return {
    auth: TestBed.inject(AuthService),
    ctl: TestBed.inject(HttpTestingController),
    reload,
  };
}

/** Sign in through the real login call (so the session is stored as the app stores it). */
async function signIn(
  auth: AuthService,
  ctl: HttpTestingController,
  access: string,
  remember = true,
) {
  const done = auth.login(
    { email: 'p@x.test', password: 'pw' } as never,
    remember,
  );
  await settle();
  ctl
    .expectOne(`${BASE}/api/portal/auth/login`)
    .flush({ data: { access_token: access, refresh_token: 'R-new' } });
  await done;
}

describe('AuthService (patient) — token freshness and session end', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('ensureFreshToken refreshes a token about to expire, and leaves a fresh one alone', async () => {
    const { auth, ctl } = setup({ access: tokenFor('p1', 30) });
    const B = tokenFor('p1', 900, { n: 2 });
    const pending = auth.ensureFreshToken();
    await settle();
    ctl.expectOne(isRefresh).flush({ data: { access_token: B } });
    await pending;
    expect(auth.token()).toBe(B);
    await auth.ensureFreshToken();
    expect(ctl.match(isRefresh)).toHaveLength(0);
    ctl.verify();
  });

  it('keeps a session that is not remembered in sessionStorage, refreshed in place', async () => {
    const { auth, ctl } = setup({
      access: tokenFor('p1', 30),
      storage: 'session',
    });
    const B = tokenFor('p1', 900, { n: 2 });
    const pending = auth.ensureFreshToken();
    await settle();
    ctl.expectOne(isRefresh).flush({ data: { access_token: B } });
    await pending;
    expect(sessionStorage.getItem('videomed.token')).toBe(B);
    expect(localStorage.getItem('videomed.token')).toBeNull();
    ctl.verify();
  });

  it('a refresh the API never answers gives up after 15 s: still signed in (no frozen tab)', async () => {
    vi.useFakeTimers();
    try {
      const { auth, ctl } = setup({ access: tokenFor('p1', -5) });
      const result = auth.refresh();
      await vi.advanceTimersByTimeAsync(0);
      const pending = ctl.expectOne(isRefresh);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(result).resolves.toBe(false);
      expect(pending.cancelled).toBe(true);
      expect(auth.isAuthenticated()).toBe(true);
      expect(auth.hasRefreshToken()).toBe(true);
      ctl.verify();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a sign-out during an in-flight refresh stays signed out', async () => {
    const { auth, ctl } = setup({ access: tokenFor('p1', -5) });
    const result = auth.refresh();
    await settle();
    const pending = ctl.expectOne(isRefresh);
    await auth.logout();
    pending.flush({ data: { access_token: tokenFor('p1', 900) } });
    await expect(result).resolves.toBe(false);
    expect(auth.token()).toBeNull();
    expect(localStorage.getItem('videomed.token')).toBeNull();
    ctl.match(isLogout).forEach((r) => r.flush({}));
    ctl.verify();
  });

  it('an involuntary sign-out forgets the multi-step flow state too', () => {
    const { auth } = setup({ access: tokenFor('p1', 900) });
    const flow = TestBed.inject(AuthFlowService);
    flow.startPhone('2348000000000', 'pin', 'login');
    auth.expire('expired');
    expect(flow.phone()).toBe('');
    expect(flow.pinId()).toBe('');
  });

  it('another patient signing in in another tab reloads this one', () => {
    const { reload } = setup({ access: tokenFor('p1', 900) });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'videomed.token',
        newValue: tokenFor('p1', 900, { n: 2 }),
        storageArea: localStorage,
      }),
    );
    expect(reload).not.toHaveBeenCalled();
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'videomed.token',
        newValue: tokenFor('p2', 900),
        storageArea: localStorage,
      }),
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  describe('return URL', () => {
    it('a page left by an expired session is the same patient’s only', async () => {
      const { auth, ctl } = setup({ access: tokenFor('p1', 900) });
      auth.expire('idle');
      auth.rememberRedirect('/dashboard/appointments/9');
      // The sign-in screen may peek before anyone has signed in.
      expect(auth.peekRedirect()).toBe('/dashboard/appointments/9');
      await signIn(auth, ctl, tokenFor('p2', 900));
      expect(auth.peekRedirect()).toBeNull();
      expect(auth.consumeRedirect()).toBeNull();
    });

    it('the same patient signing back in returns to it', async () => {
      const { auth, ctl } = setup({ access: tokenFor('p1', 900) });
      auth.expire('idle');
      auth.rememberRedirect('/dashboard/appointments/9');
      await signIn(auth, ctl, tokenFor('p1', 900, { n: 2 }));
      expect(auth.consumeRedirect()).toBe('/dashboard/appointments/9');
    });

    it('a gated action remembered while signed out (e.g. booking) is honoured for whoever signs in', async () => {
      const { auth, ctl } = setup({ refresh: null });
      auth.rememberRedirect('/dashboard/appointments/book/3');
      await signIn(auth, ctl, tokenFor('p7', 900));
      expect(auth.consumeRedirect()).toBe('/dashboard/appointments/book/3');
    });

    it('rejects other sites and the sign-in screens, and reads a legacy bare-URL entry', () => {
      const { auth } = setup({ refresh: null });
      auth.rememberRedirect('//evil.example');
      expect(auth.peekRedirect()).toBeNull();
      auth.rememberRedirect('/auth/register');
      expect(auth.peekRedirect()).toBeNull();
      sessionStorage.setItem('videomed.redirect', '/dashboard/documents');
      expect(auth.consumeRedirect()).toBe('/dashboard/documents');
    });
  });
});
