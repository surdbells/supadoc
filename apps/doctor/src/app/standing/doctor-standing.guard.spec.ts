import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  provideRouter,
  type RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import type { DoctorStandingCode } from '@supadoc/models';
import { doctorStandingGuard } from './doctor-standing.guard';
import { DoctorStandingStore } from './doctor-standing.store';

const route = {} as ActivatedRouteSnapshot;
const state = { url: '/schedule' } as RouterStateSnapshot;

/** The guard over a store whose read signs the doctor out (the session was over) or fails while signed in. */
function setup(opts: {
  endsSession?: boolean;
  code?: DoctorStandingCode | null;
}) {
  const authed = signal(true);
  const auth = {
    isAuthenticated: authed.asReadonly(),
    rememberRedirect: vi.fn(),
  };
  const store = {
    load: vi.fn(async () => {
      if (opts.endsSession) authed.set(false); // the onboarding read met an ended session
      return null;
    }),
    code: signal<DoctorStandingCode | null>(opts.code ?? null),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: StaffAuthService, useValue: auth },
      { provide: DoctorStandingStore, useValue: store },
    ],
  });
  return {
    auth,
    run: () =>
      TestBed.runInInjectionContext(() =>
        doctorStandingGuard(route, state),
      ) as Promise<boolean | UrlTree>,
  };
}

describe('doctorStandingGuard', () => {
  it('signed out by the standing read: the sign-in page (remembering the page) — never a broken clinical page', async () => {
    const { auth, run } = setup({ endsSession: true });
    const result = await run();
    expect(result).toBeInstanceOf(UrlTree);
    expect(String(result)).toBe('/auth/login');
    expect(auth.rememberRedirect).toHaveBeenCalledWith('/schedule');
  });

  it('a standing that could not be read while still signed in: fails open (the API enforces it)', async () => {
    const { run } = setup({});
    await expect(run()).resolves.toBe(true);
  });

  it('a suspended doctor goes to the account status page', async () => {
    const { run } = setup({ code: 'doctor_suspended' });
    expect(String(await run())).toBe('/account-status?page=schedule');
  });
});
