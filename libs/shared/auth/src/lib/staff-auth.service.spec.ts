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
import { provideStaffAuth } from './provide-staff-auth';
import { consumeSessionNotice } from './session/session-notice';
import { RELOAD_PAGE } from './session/session-utils';
import { tokenFor } from './session/testing';
import { staffAuthInterceptor } from './staff-auth.interceptor';
import { StaffAuthService } from './staff-auth.service';

const BASE = 'https://api.test';
const KEY = 'test.doctor.token';
const isRefresh = (r: { url: string }) => r.url === `${BASE}/api/auth/refresh`;
const isLogout = (r: { url: string }) => r.url === `${BASE}/api/auth/logout`;
const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(access: string | null, refresh: string | null = 'R1') {
  localStorage.clear();
  sessionStorage.clear();
  if (access) localStorage.setItem(KEY, access);
  if (refresh) localStorage.setItem(`${KEY}.refresh`, refresh);
  const reload = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(
        withInterceptors([httpErrorInterceptor, staffAuthInterceptor]),
      ),
      provideHttpClientTesting(),
      provideSupadocDataAccess({ baseUrl: BASE }),
      provideStaffAuth({ storageKey: KEY, requiredRole: 'doctor' }),
      {
        provide: LOGGER,
        useValue: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      { provide: RELOAD_PAGE, useValue: reload },
    ],
  });
  return {
    auth: TestBed.inject(StaffAuthService),
    ctl: TestBed.inject(HttpTestingController),
    reload,
  };
}

describe('StaffAuthService — token freshness and session end', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('ensureFreshToken: nothing to do for a fresh token', async () => {
    const { auth, ctl } = setup(tokenFor('d1', 900));
    await auth.ensureFreshToken();
    expect(ctl.match(isRefresh)).toHaveLength(0);
    ctl.verify();
  });

  it('ensureFreshToken: refreshes a token about to expire (once, however many callers)', async () => {
    const B = tokenFor('d1', 900, { n: 2 });
    const { auth, ctl } = setup(tokenFor('d1', 30));
    const a = auth.ensureFreshToken();
    const b = auth.ensureFreshToken();
    await settle();
    ctl.expectOne(isRefresh).flush({ data: { access_token: B } });
    await Promise.all([a, b]);
    expect(auth.token()).toBe(B);
    expect(localStorage.getItem(KEY)).toBe(B);
    ctl.verify();
  });

  it('ensureFreshToken: waits for a refresh already in flight, even with a fresh token', async () => {
    const B = tokenFor('d1', 900, { n: 2 });
    const { auth, ctl } = setup(tokenFor('d1', 900));
    const running = auth.refresh();
    let waited = false;
    const fresh = auth.ensureFreshToken().then(() => (waited = true));
    await settle();
    expect(waited).toBe(false);
    ctl.expectOne(isRefresh).flush({ data: { access_token: B } });
    await Promise.all([running, fresh]);
    expect(waited).toBe(true);
    expect(auth.token()).toBe(B);
    ctl.verify();
  });

  it('ensureFreshToken: an opaque token (no expiry) is never refreshed ahead — no loop', async () => {
    const { auth, ctl } = setup('opaque-token');
    await auth.ensureFreshToken();
    expect(ctl.match(isRefresh)).toHaveLength(0);
    ctl.verify();
  });

  it('backs off after a transient failure: 5 s with no Retry-After, then tries again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
    const { auth, ctl } = setup(tokenFor('d1', -5));
    const first = auth.refresh();
    await settle();
    ctl
      .expectOne(isRefresh)
      .flush(
        { message: 'Bad gateway' },
        { status: 502, statusText: 'Bad Gateway' },
      );
    await expect(first).resolves.toBe(false);
    expect(auth.isAuthenticated()).toBe(true);

    await expect(auth.refresh()).resolves.toBe(false); // within the back-off: no request
    await auth.ensureFreshToken();
    expect(ctl.match(isRefresh)).toHaveLength(0);

    vi.setSystemTime(new Date('2026-10-20T10:00:06Z'));
    const again = auth.refresh();
    await settle();
    ctl
      .expectOne(isRefresh)
      .flush({ data: { access_token: tokenFor('d1', 900) } });
    await expect(again).resolves.toBe(true);
    ctl.verify();
  });

  it('a definitive refusal ends the session with the server reason as the sign-in notice', async () => {
    const { auth, ctl } = setup(tokenFor('d1', -5));
    const result = auth.refresh();
    await settle();
    ctl
      .expectOne(isRefresh)
      .flush(
        {
          status: 'error',
          message: 'This account has been deactivated.',
          errors: {
            auth: 'This account has been deactivated.',
            code: 'account_deactivated',
          },
        },
        { status: 401, statusText: 'Unauthorized' },
      );
    await expect(result).resolves.toBe(false);
    expect(auth.isAuthenticated()).toBe(false);
    expect(consumeSessionNotice()).toBe('This account has been deactivated.');
    ctl.match(isLogout).forEach((r) => r.flush({}));
    ctl.verify();
  });

  it('a sign-out during an in-flight refresh stays signed out (the refresh never brings it back)', async () => {
    const { auth, ctl } = setup(tokenFor('d1', -5));
    const result = auth.refresh();
    await settle();
    const pending = ctl.expectOne(isRefresh);
    auth.logout();
    pending.flush({ data: { access_token: tokenFor('d1', 900) } });
    await expect(result).resolves.toBe(false);
    expect(auth.token()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    ctl.match(isLogout).forEach((r) => r.flush({}));
    ctl.verify();
  });

  it('two tabs refreshing at once: the second adopts the token the first stored (no second request)', async () => {
    const fresh = tokenFor('d1', 900, { n: 2 });
    // The other tab held the lock and stored its new token meanwhile.
    vi.stubGlobal('navigator', {
      locks: {
        request: async (
          _name: string,
          _opts: unknown,
          cb: () => Promise<unknown>,
        ) => {
          localStorage.setItem(KEY, fresh);
          return cb();
        },
      },
    });
    try {
      const { auth, ctl } = setup(tokenFor('d1', 20));
      await expect(auth.refresh()).resolves.toBe(true);
      expect(auth.token()).toBe(fresh);
      expect(ctl.match(isRefresh)).toHaveLength(0);
      ctl.verify();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a lock that is not granted (another tab hangs) never stops this tab refreshing', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        request: () =>
          Promise.reject(new DOMException('timed out', 'AbortError')),
      },
    });
    try {
      const { auth, ctl } = setup(tokenFor('d1', 20));
      const result = auth.refresh();
      await settle();
      ctl
        .expectOne(isRefresh)
        .flush({ data: { access_token: tokenFor('d1', 900) } });
      await expect(result).resolves.toBe(true);
      ctl.verify();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a refresh the API never answers gives up after 15 s: still signed in, backing off (no frozen tab)', async () => {
    vi.useFakeTimers();
    const { auth, ctl } = setup(tokenFor('d1', -5));
    const result = auth.refresh();
    await vi.advanceTimersByTimeAsync(0);
    const pending = ctl.expectOne(isRefresh);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(pending.cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
    expect(pending.cancelled).toBe(true);
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.hasRefreshToken()).toBe(true);
    // Backing off: an immediate retry makes no request.
    await expect(auth.refresh()).resolves.toBe(false);
    expect(ctl.match(isRefresh)).toHaveLength(0);
    ctl.verify();
  });

  it('takes the user from another tab when its write lands after the token’s', () => {
    const { auth } = setup(tokenFor('d1', 900));
    const user = { id: 'd2', roles: ['doctor'], permissions: [], first_name: 'Ada', last_name: 'Obi' };
    localStorage.setItem(`${KEY}.user`, JSON.stringify(user));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: `${KEY}.user`,
        newValue: JSON.stringify(user),
        storageArea: localStorage,
      }),
    );
    expect(auth.user()?.id).toBe('d2');
    expect(auth.hasRole('doctor')).toBe(true);
  });

  it('another user signing in in another tab reloads this one', () => {
    const { auth, reload } = setup(tokenFor('d1', 900));
    // The same user refreshing elsewhere: adopted quietly.
    const same = tokenFor('d1', 900, { n: 2 });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: KEY,
        newValue: same,
        storageArea: localStorage,
      }),
    );
    expect(auth.token()).toBe(same);
    expect(reload).not.toHaveBeenCalled();
    // Someone else.
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: KEY,
        newValue: tokenFor('d2', 900),
        storageArea: localStorage,
      }),
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  describe('return URL', () => {
    it('is kept only for same-app paths', () => {
      const { auth } = setup(null, null);
      auth.rememberRedirect('//evil.example/x');
      expect(auth.consumeRedirect()).toBeNull();
      auth.rememberRedirect('/auth/login');
      expect(auth.consumeRedirect()).toBeNull();
      auth.rememberRedirect('/patients/7');
      expect(auth.consumeRedirect()).toBe('/patients/7');
      expect(auth.consumeRedirect()).toBeNull(); // consumed
    });

    it('is honoured for the same doctor after an involuntary sign-out, dropped for another', () => {
      const { auth } = setup(tokenFor('d1', 900));
      auth.expire('idle');
      auth.rememberRedirect('/patients/7'); // the page d1 was on
      // d1 signs back in.
      (
        auth as unknown as {
          store: (a: string, r: string | null, u: unknown) => void;
        }
      ).store(tokenFor('d1', 900), 'R2', {
        roles: ['doctor'],
        permissions: [],
      });
      expect(auth.consumeRedirect()).toBe('/patients/7');

      auth.expire('idle');
      auth.rememberRedirect('/patients/7');
      // d2 signs in at the same screen.
      (
        auth as unknown as {
          store: (a: string, r: string | null, u: unknown) => void;
        }
      ).store(tokenFor('d2', 900), 'R3', {
        roles: ['doctor'],
        permissions: [],
      });
      expect(auth.consumeRedirect()).toBeNull();
    });

    it('remembered before anyone signed in: honoured for whoever signs in', () => {
      const { auth } = setup(null, null);
      auth.rememberRedirect('/schedule');
      (
        auth as unknown as {
          store: (a: string, r: string | null, u: unknown) => void;
        }
      ).store(tokenFor('d9', 900), 'R', { roles: ['doctor'], permissions: [] });
      expect(auth.consumeRedirect()).toBe('/schedule');
    });
  });
});
