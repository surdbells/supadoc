import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { CanLeave, LeavePrompt, unsavedChangesGuard } from './unsaved-changes.guard';

const state = {} as RouterStateSnapshot;
/** A page under the signed-in shell (`canActivate: [staffAuthGuard]` on a parent). */
const protectedRoute = {
  pathFromRoot: [{ routeConfig: null }, { routeConfig: { canActivate: [() => true] } }],
} as unknown as ActivatedRouteSnapshot;
/** The in-call cockpit: reachable without a portal session. */
const publicRoute = { pathFromRoot: [{ routeConfig: { path: 'call/:token' } }] } as unknown as ActivatedRouteSnapshot;

function setup(signedIn = true) {
  const authed = signal(signedIn);
  const rememberRedirect = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: StaffAuthService, useValue: { isAuthenticated: authed.asReadonly(), rememberRedirect } },
    ],
  });
  const guard = (component: Partial<CanLeave> | null, route = protectedRoute) =>
    TestBed.runInInjectionContext(() => unsavedChangesGuard(component, route, state, state));
  return { authed, guard };
}

describe('unsavedChangesGuard', () => {
  it('lets a page without canLeave() go', () => {
    const { guard } = setup();
    expect(guard({})).toBe(true);
    expect(guard(null)).toBe(true);
  });

  it("returns the page's own answer", async () => {
    const { guard } = setup();
    expect(guard({ canLeave: () => false })).toBe(false);
    await expect(guard({ canLeave: () => Promise.resolve(true) }) as Promise<unknown>).resolves.toBe(true);
  });

  it('never asks once signed out on a signed-in-only page', () => {
    const { guard } = setup(false);
    const canLeave = vi.fn(() => false);
    expect(guard({ canLeave })).toBe(true);
    expect(canLeave).not.toHaveBeenCalled();
  });

  it('sends the doctor to sign in when the session ends while they are being asked', async () => {
    const { authed, guard } = setup();
    const prompt = new LeavePrompt();
    const result = guard({ canLeave: () => prompt.ask() }) as Promise<boolean | UrlTree>;
    authed.set(false);
    TestBed.tick();
    const answer = await result;
    expect(answer instanceof UrlTree).toBe(true);
    expect(TestBed.inject(Router).serializeUrl(answer as UrlTree)).toBe('/auth/login');
  });

  it('keeps asking on the in-call cockpit, which needs no portal session', async () => {
    const { authed, guard } = setup();
    const prompt = new LeavePrompt();
    const result = guard({ canLeave: () => prompt.ask() }, publicRoute) as Promise<boolean>;
    authed.set(false);
    TestBed.tick();
    prompt.answer(false);
    await expect(result).resolves.toBe(false);
  });
});

describe('LeavePrompt', () => {
  it('opens on ask() and resolves with the answer', async () => {
    const prompt = new LeavePrompt();
    const answer = prompt.ask();
    expect(prompt.open()).toBe(true);
    prompt.answer(true);
    expect(prompt.open()).toBe(false);
    await expect(answer).resolves.toBe(true);
  });

  it('answers an older, unanswered question with "stay"', async () => {
    const prompt = new LeavePrompt();
    const first = prompt.ask();
    const second = prompt.ask();
    await expect(first).resolves.toBe(false);
    prompt.answer(true);
    await expect(second).resolves.toBe(true);
  });
});
