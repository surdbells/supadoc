import { signal, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { SESSION_AUTH, type SessionAuth } from './session-auth';
import { setSessionNotice } from './session-notice';
import {
  provideSessionTimeout,
  SESSION_TIMEOUT_CONFIG,
  SessionTimeoutService,
} from './session-timeout.service';
import { RELOAD_PAGE } from './session-utils';

const MIN = 60_000;

/** A stand-in auth silo whose token, deadline and sign-out the test controls. */
function fakeAuth(opts: { accessMs: number; deadlineMs?: number | null }) {
  const authed = signal(true);
  const clock = {
    exp: Date.now() + opts.accessMs,
    deadline: opts.deadlineMs == null ? null : Date.now() + opts.deadlineMs,
  };
  const auth = {
    token: signal<string | null>('opaque').asReadonly(),
    isAuthenticated: authed.asReadonly(),
    hasRefreshToken: () => true,
    refresh: vi.fn(async () => true),
    ensureFreshToken: vi.fn(async () => undefined),
    expire: vi.fn((reason: string) => {
      setSessionNotice(reason as never);
      authed.set(false);
    }),
    logout: vi.fn(() => authed.set(false)),
    keepAlive: vi.fn(async () => undefined),
    sessionDeadline: () => clock.deadline,
    accessExpiresAt: () => clock.exp,
    rememberRedirect: vi.fn(),
    activityKey: 'test.activity',
  } satisfies SessionAuth;
  return { auth, authed, clock };
}

function setup(
  opts: {
    accessMs?: number;
    deadlineMs?: number | null;
    idleMinutes?: number;
    routes?: Routes;
  } = {},
) {
  localStorage.clear();
  sessionStorage.clear();
  const fake = fakeAuth({
    accessMs: opts.accessMs ?? 10 * MIN,
    deadlineMs: opts.deadlineMs ?? null,
  });
  TestBed.configureTestingModule({
    providers: [
      provideRouter(opts.routes ?? []),
      { provide: SESSION_AUTH, useValue: fake.auth },
      {
        provide: SESSION_TIMEOUT_CONFIG,
        useValue: {
          idleMinutes: opts.idleMinutes ?? 15,
          warningSeconds: 60,
          keepAliveMinutes: 4,
          loginUrl: '/auth/login',
          deadlineWarningMinutes: 5,
        },
      },
    ],
  });
  const service = TestBed.inject(SessionTimeoutService);
  service.start();
  TestBed.tick(); // the sign-in transition effect
  return { service, ...fake };
}

let visibility: DocumentVisibilityState = 'visible';

describe('SessionTimeoutService', () => {
  beforeAll(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });

  beforeEach(() => {
    visibility = 'visible';
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('refreshing ahead of expiry', () => {
    beforeEach(() => vi.useFakeTimers());

    it('refreshes two minutes before the token expires while the user is active in a visible tab', () => {
      const { auth } = setup({ accessMs: 10 * MIN });
      vi.advanceTimersByTime(7 * MIN + 50_000); // 2 min 10 s left
      expect(auth.refresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(15_000); // under 2 min left
      expect(auth.refresh).toHaveBeenCalledTimes(1);
    });

    it('does not refresh for a hidden tab, or for a user idle for 15 minutes', () => {
      visibility = 'hidden';
      const hidden = setup({ accessMs: 3 * MIN, idleMinutes: 30 });
      vi.advanceTimersByTime(2 * MIN);
      expect(hidden.auth.refresh).not.toHaveBeenCalled();

      TestBed.resetTestingModule();
      visibility = 'visible';
      const idle = setup({ accessMs: 20 * MIN, idleMinutes: 30 });
      vi.advanceTimersByTime(19 * MIN); // 1 min left, last activity 19 min ago
      expect(idle.auth.refresh).not.toHaveBeenCalled();
    });

    it('always refreshes while a hold is on — a call screen in a hidden tab keeps working', () => {
      visibility = 'hidden';
      const { service, auth } = setup({ accessMs: 3 * MIN });
      service.hold('call');
      vi.advanceTimersByTime(MIN + 5_000);
      expect(auth.refresh).toHaveBeenCalledTimes(1);
    });

    it('tries at most every 30 seconds', () => {
      const { auth } = setup({ accessMs: MIN }); // inside the window from the start
      vi.advanceTimersByTime(1_000);
      expect(auth.refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(28_000);
      expect(auth.refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_000);
      expect(auth.refresh).toHaveBeenCalledTimes(2);
    });
  });

  describe('holds (a live call, an upload)', () => {
    beforeEach(() => vi.useFakeTimers());

    it('never signs anyone out for idleness while held; the idle clock restarts on release', () => {
      const { service, auth } = setup({ accessMs: 60 * MIN, idleMinutes: 15 });
      service.hold('call');
      vi.advanceTimersByTime(40 * MIN);
      expect(auth.expire).not.toHaveBeenCalled();
      expect(service.warning()).toBe(false);
      service.release('call');
      vi.advanceTimersByTime(14 * MIN);
      expect(auth.expire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(MIN + 1_000);
      expect(auth.expire).toHaveBeenCalledWith('idle');
    });

    it('the absolute lifetime running out mid-call ends the session only when the call ends', () => {
      const { service, auth } = setup({
        accessMs: 60 * MIN,
        deadlineMs: 10 * MIN,
      });
      service.hold('call');
      vi.advanceTimersByTime(11 * MIN);
      expect(auth.expire).not.toHaveBeenCalled();
      service.release('call');
      expect(auth.expire).toHaveBeenCalledWith('expired');
    });

    it('a session signed in again (another tab) during the call is not ended when the call ends', () => {
      const { service, auth, clock } = setup({
        accessMs: 60 * MIN,
        deadlineMs: 10 * MIN,
      });
      service.hold('call');
      vi.advanceTimersByTime(11 * MIN); // the old session's lifetime ran out mid-call
      expect(auth.expire).not.toHaveBeenCalled();
      // A new session (its own, later deadline) replaced it before any request noticed.
      clock.deadline = Date.now() + 12 * 60 * MIN;
      service.release('call');
      expect(auth.expire).not.toHaveBeenCalled();
      // …and a tick after the release does not end it either.
      vi.advanceTimersByTime(2_000);
      expect(auth.expire).not.toHaveBeenCalled();
    });

    it('warns of the absolute lifetime 30 minutes ahead in a call (5 minutes otherwise)', () => {
      const { service } = setup({ accessMs: 60 * MIN, deadlineMs: 40 * MIN });
      vi.advanceTimersByTime(11 * MIN); // 29 min left
      expect(service.deadlineSoon()).toBeNull();
      service.hold('call');
      expect(service.holding()).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(service.deadlineSoon()).not.toBeNull();
    });

    it('an upload hold pauses the idle timer but is not a call (no in-call notice)', () => {
      const { service, auth } = setup({ accessMs: 60 * MIN, idleMinutes: 15 });
      service.hold('upload:1');
      expect(service.holding()).toBe(false);
      vi.advanceTimersByTime(20 * MIN);
      expect(auth.expire).not.toHaveBeenCalled();
      service.release('upload:1');
    });
  });

  describe('another user signing in in another tab (the page reload)', () => {
    const records = { path: 'records', children: [] };
    const schedule = { path: 'schedule', children: [] };

    it('reloads at once when no call holds the session', () => {
      const { service } = setup();
      const reload = vi.fn();
      service.reloadWhenFree(reload);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('never mid-call — nor on the release (the call screen is still open) — but at the next navigation', async () => {
      const { service } = setup({ routes: [records, schedule] });
      const router = TestBed.inject(Router);
      await router.navigateByUrl('/records');
      service.hold('call');
      const reload = vi.fn();
      service.reloadWhenFree(reload);
      expect(reload).not.toHaveBeenCalled();
      service.release('call');
      expect(reload).not.toHaveBeenCalled();
      await router.navigateByUrl('/schedule');
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('an upload alone does not defer it (only a call does)', () => {
      const { service } = setup();
      service.hold('upload:1');
      const reload = vi.fn();
      service.reloadWhenFree(reload);
      expect(reload).toHaveBeenCalledTimes(1);
      service.release('upload:1');
    });

    it('provideSessionTimeout sends the auth service’s reload through reloadWhenFree', () => {
      localStorage.clear();
      const { auth } = fakeAuth({ accessMs: 10 * MIN });
      abstract class FakeAuth {}
      TestBed.configureTestingModule({
        providers: [
          provideRouter([]),
          { provide: FakeAuth, useValue: auth },
          provideSessionTimeout(FakeAuth as unknown as Type<SessionAuth>, {
            idleMinutes: 15,
          }),
        ],
      });
      const service = TestBed.inject(SessionTimeoutService);
      const deferred = vi
        .spyOn(service, 'reloadWhenFree')
        .mockImplementation(() => undefined);
      TestBed.inject(RELOAD_PAGE)();
      expect(deferred).toHaveBeenCalledTimes(1);
    });
  });

  describe('leaving a protected page when signed out', () => {
    const page = { path: 'records', canActivate: [() => true], children: [] };
    const login = { path: 'auth/login', children: [] };

    it('a sign-out during a navigation still ends on the sign-in page once it settles', async () => {
      let letThrough: ((ok: boolean) => void) | undefined;
      const slow = {
        path: 'slow',
        canActivate: [() => new Promise<boolean>((r) => (letThrough = r))],
        children: [],
      };
      const { authed, auth } = setup({ routes: [page, slow, login] });
      const router = TestBed.inject(Router);
      await router.navigateByUrl('/records');
      const going = router.navigateByUrl('/slow');
      // The navigation is now waiting on its guard (e.g. the onboarding read).
      for (let i = 0; i < 20 && !letThrough; i++)
        await new Promise((r) => setTimeout(r, 0));
      expect(router.currentNavigation()).not.toBeNull();
      auth.expire('expired');
      expect(authed()).toBe(false);
      TestBed.tick(); // the sign-out transition runs while the navigation is still under way
      letThrough?.(true);
      await going;
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(router.url).toBe('/auth/login');
      expect(auth.rememberRedirect).toHaveBeenCalledWith('/slow');
    });

    it('never navigates away while a call holds the session; leaves on release', async () => {
      const { service, auth } = setup({ routes: [page, login] });
      const router = TestBed.inject(Router);
      await router.navigateByUrl('/records');
      service.hold('call');
      auth.expire('revoked');
      TestBed.tick();
      await new Promise((r) => setTimeout(r, 0));
      expect(router.url).toBe('/records');
      service.release('call');
      await new Promise((r) => setTimeout(r, 0));
      expect(router.url).toBe('/auth/login');
    });
  });
});
