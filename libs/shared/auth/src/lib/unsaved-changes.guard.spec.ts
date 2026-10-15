import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { DialogService } from '@supadoc/ui';
import { SESSION_AUTH, SessionAuth } from './session/session-auth';
import { SESSION_TIMEOUT_CONFIG } from './session/session-timeout.service';
import { LeaveGuarded, unsavedChangesGuard } from './unsaved-changes.guard';

const state = {} as RouterStateSnapshot;
/** A page under the signed-in shell (`canActivate: [authGuard]` on a parent). */
const protectedRoute = {
  pathFromRoot: [{ routeConfig: null }, { routeConfig: { canActivate: [() => true] } }],
} as unknown as ActivatedRouteSnapshot;
/** An in-call / guest page: reachable without a session. */
const publicRoute = { pathFromRoot: [{ routeConfig: { path: 'call/:token' } }] } as unknown as ActivatedRouteSnapshot;

function setup(options: { signedIn?: boolean; session?: boolean; loginUrl?: string } = {}) {
  const authed = signal(options.signedIn ?? true);
  const rememberRedirect = vi.fn();
  const session = { isAuthenticated: authed.asReadonly(), rememberRedirect } as unknown as SessionAuth;
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      ...(options.session === false ? [] : [{ provide: SESSION_AUTH, useValue: session }]),
      ...(options.loginUrl ? [{ provide: SESSION_TIMEOUT_CONFIG, useValue: { loginUrl: options.loginUrl } }] : []),
    ],
  });
  const dialogs = TestBed.inject(DialogService);
  const guard = (component: LeaveGuarded | null, route = protectedRoute) =>
    TestBed.runInInjectionContext(() => unsavedChangesGuard(component, route, state, state));
  return { authed, guard, dialogs, rememberRedirect };
}

describe('unsavedChangesGuard (shared)', () => {
  it('lets a page without canLeave() / hasUnsavedChanges() go', () => {
    const { guard } = setup();
    expect(guard({})).toBe(true);
    expect(guard(null)).toBe(true);
  });

  it("returns the page's own canLeave() answer", async () => {
    const { guard } = setup();
    expect(guard({ canLeave: () => false })).toBe(false);
    await expect(guard({ canLeave: () => Promise.resolve(true) }) as Promise<unknown>).resolves.toBe(true);
  });

  it('asks with the standard prompt when hasUnsavedChanges() is true', async () => {
    const { guard, dialogs } = setup();
    const confirmLeave = vi.spyOn(dialogs, 'confirmLeave');
    expect(guard({ hasUnsavedChanges: () => false })).toBe(true);
    expect(confirmLeave).not.toHaveBeenCalled();

    const result = guard({
      hasUnsavedChanges: () => true,
      leaveCopy: () => ({ title: 'Discard your changes?' }),
    }) as Promise<boolean | UrlTree>;
    expect(confirmLeave).toHaveBeenCalledWith({ title: 'Discard your changes?' });
    dialogs.requests()[0].confirm();
    await expect(result).resolves.toBe(true);
  });

  it('never asks once signed out on a signed-in-only page', () => {
    const { guard } = setup({ signedIn: false });
    const canLeave = vi.fn(() => false);
    const hasUnsavedChanges = vi.fn(() => true);
    expect(guard({ canLeave })).toBe(true);
    expect(guard({ hasUnsavedChanges })).toBe(true);
    expect(canLeave).not.toHaveBeenCalled();
    expect(hasUnsavedChanges).not.toHaveBeenCalled();
  });

  it('closes the prompt and goes to sign in when the session ends while asking', async () => {
    const { authed, guard, dialogs } = setup({ loginUrl: '/auth/sign-in' });
    const result = guard({ hasUnsavedChanges: () => true }) as Promise<boolean | UrlTree>;
    expect(dialogs.hasOpen()).toBe(true);
    authed.set(false);
    TestBed.tick();
    const answer = await result;
    expect(answer instanceof UrlTree).toBe(true);
    expect(TestBed.inject(Router).serializeUrl(answer as UrlTree)).toBe('/auth/sign-in');
    expect(dialogs.hasOpen()).toBe(false);
  });

  it('keeps asking on a page that needs no session', async () => {
    const { authed, guard, dialogs } = setup();
    const result = guard({ hasUnsavedChanges: () => true }, publicRoute) as Promise<boolean>;
    authed.set(false);
    TestBed.tick();
    expect(dialogs.hasOpen()).toBe(true);
    dialogs.requests()[0].cancel();
    await expect(result).resolves.toBe(false);
  });

  it('works without any session wiring (no SESSION_AUTH)', async () => {
    const { guard, dialogs } = setup({ session: false });
    const result = guard({ hasUnsavedChanges: () => true }) as Promise<boolean>;
    dialogs.requests()[0].cancel();
    await expect(result).resolves.toBe(false);
  });
});
