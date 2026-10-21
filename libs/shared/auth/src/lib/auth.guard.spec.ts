import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  provideRouter,
  Router,
  type RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import { authGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { StaffAuthService } from './staff-auth.service';
import { staffAuthGuard, WRONG_PORTAL_MESSAGE } from './staff-auth.guard';

const route = {} as ActivatedRouteSnapshot;
const state = { url: '/schedule?day=2' } as RouterStateSnapshot;

/** A stand-in auth silo: signed in or not, with an access token expiring in `expiresInMs`. */
function fakeAuth(
  opts: {
    signedIn?: boolean;
    expiresInMs?: number | null;
    refresh?: 'ok' | 'refused' | 'transient';
  } = {},
) {
  const authed = signal(opts.signedIn ?? true);
  const expiresIn = opts.expiresInMs === undefined ? 600_000 : opts.expiresInMs;
  const user = signal<{ roles: string[] } | null>({ roles: ['doctor'] });
  const fake = {
    isAuthenticated: authed.asReadonly(),
    accessExpiresAt: () => (expiresIn === null ? null : Date.now() + expiresIn),
    ensureFreshToken: vi.fn(async () => {
      if (opts.refresh === 'refused') authed.set(false);
    }),
    rememberRedirect: vi.fn(),
    expire: vi.fn(() => authed.set(false)),
    requiredRole: () => 'doctor',
    user: user.asReadonly(),
    setUser: (u: { roles: string[] } | null) => user.set(u),
    loadMe: vi.fn(async (): Promise<{ roles: string[] } | null> => null),
    signOut: () => authed.set(false),
  };
  return fake;
}

function run(
  guard: typeof authGuard,
  fake: ReturnType<typeof fakeAuth>,
  token: typeof AuthService | typeof StaffAuthService,
) {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: token, useValue: fake }],
  });
  return TestBed.runInInjectionContext(() => guard(route, state));
}

const loginTree = () => TestBed.inject(Router).parseUrl('/auth/login');

for (const [name, guard, token] of [
  ['authGuard (patient)', authGuard, AuthService],
  ['staffAuthGuard (doctor / back office)', staffAuthGuard, StaffAuthService],
] as const) {
  describe(name, () => {
    it('a fresh token: allowed at once (synchronously), no refresh', () => {
      const fake = fakeAuth();
      expect(run(guard, fake, token)).toBe(true);
      expect(fake.ensureFreshToken).not.toHaveBeenCalled();
    });

    it('a token about to expire: refreshed first, then allowed', async () => {
      const fake = fakeAuth({ expiresInMs: 20_000, refresh: 'ok' });
      const result = run(guard, fake, token);
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBe(true);
      expect(fake.ensureFreshToken).toHaveBeenCalledTimes(1);
    });

    it('refresh refused (the session is over): the sign-in page, remembering where they were going', async () => {
      const fake = fakeAuth({ expiresInMs: -1_000, refresh: 'refused' });
      const result = (await run(guard, fake, token)) as UrlTree;
      expect(result.toString()).toBe(loginTree().toString());
      expect(fake.rememberRedirect).toHaveBeenCalledWith('/schedule?day=2');
    });

    it('refresh failed for now (offline): allowed — the API still enforces the session', async () => {
      const fake = fakeAuth({ expiresInMs: -1_000, refresh: 'transient' });
      await expect(run(guard, fake, token)).resolves.toBe(true);
    });

    it('signed out: the sign-in page at once', () => {
      const fake = fakeAuth({ signedIn: false });
      const result = run(guard, fake, token) as UrlTree;
      expect(result.toString()).toBe(loginTree().toString());
      expect(fake.rememberRedirect).toHaveBeenCalledWith('/schedule?day=2');
    });

    it('a refresh that hangs never freezes navigation: the page opens after 10 s (signed in)', async () => {
      vi.useFakeTimers();
      try {
        const fake = fakeAuth({ expiresInMs: -1_000 });
        fake.ensureFreshToken.mockReturnValue(new Promise<void>(() => undefined));
        let result: unknown = 'pending';
        void (run(guard, fake, token) as Promise<unknown>).then((r) => (result = r));
        await vi.advanceTimersByTimeAsync(9_999);
        expect(result).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        expect(result).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('works as canActivateChild (same signature, same answers)', () => {
      const fake = fakeAuth();
      TestBed.configureTestingModule({
        providers: [provideRouter([]), { provide: token, useValue: fake }],
      });
      expect(TestBed.runInInjectionContext(() => guard(route, state))).toBe(
        true,
      );
    });
  });
}

describe('staffAuthGuard — role', () => {
  it('an account without the portal’s role is signed out with a notice, then sent to sign in', () => {
    const fake = fakeAuth();
    fake.setUser({ roles: ['admin'] });
    const result = run(staffAuthGuard, fake, StaffAuthService) as UrlTree;
    expect(fake.expire).toHaveBeenCalledWith('revoked', WRONG_PORTAL_MESSAGE);
    expect(result.toString()).toBe(loginTree().toString());
  });

  it('no cached user yet (e.g. not arrived from the tab that signed in): loaded first, never signed out for it', async () => {
    const fake = fakeAuth();
    fake.setUser(null);
    fake.loadMe.mockResolvedValue({ roles: ['doctor'] });
    await expect(run(staffAuthGuard, fake, StaffAuthService)).resolves.toBe(true);
    expect(fake.loadMe).toHaveBeenCalledTimes(1);
    expect(fake.expire).not.toHaveBeenCalled();
  });

  it('no cached user and it cannot be loaded for now: the page opens (the API enforces roles)', async () => {
    const fake = fakeAuth();
    fake.setUser(null);
    await expect(run(staffAuthGuard, fake, StaffAuthService)).resolves.toBe(true);
    expect(fake.expire).not.toHaveBeenCalled();
  });

  it('no cached user, and loading it found the session over: the sign-in page', async () => {
    const fake = fakeAuth();
    fake.setUser(null);
    fake.loadMe.mockImplementation(async () => {
      fake.signOut(); // its 401 ended the session
      return null;
    });
    const result = (await run(staffAuthGuard, fake, StaffAuthService)) as UrlTree;
    expect(result.toString()).toBe(loginTree().toString());
    expect(fake.rememberRedirect).toHaveBeenCalledWith('/schedule?day=2');
    expect(fake.expire).not.toHaveBeenCalled();
  });

  it('the loaded user lacks the role: signed out with the notice', async () => {
    const fake = fakeAuth();
    fake.setUser(null);
    fake.loadMe.mockResolvedValue({ roles: ['admin'] });
    const result = (await run(staffAuthGuard, fake, StaffAuthService)) as UrlTree;
    expect(fake.expire).toHaveBeenCalledWith('revoked', WRONG_PORTAL_MESSAGE);
    expect(result.toString()).toBe(loginTree().toString());
  });
});
