import { effect, EffectRef, inject, Injector, signal, untracked } from '@angular/core';
import type { ActivatedRouteSnapshot, CanDeactivateFn, UrlTree } from '@angular/router';
import { Router } from '@angular/router';
import { peekSessionNotice, SESSION_TIMEOUT_CONFIG, StaffAuthService } from '@supadoc/auth';

/** A routed page (or panel) that may hold edits that have not been saved. */
export interface CanLeave {
  /**
   * True when it is fine to leave now. When there are unsaved changes it may
   * ask the doctor first and resolve with their answer.
   */
  canLeave(): boolean | Promise<boolean>;
}

/**
 * Route guard: asks the page, through its `canLeave()`, before the router
 * navigates away, so a half-written prescription is never thrown away without
 * a warning (the page's own back link, the sidebar, the browser Back button).
 * A page without `canLeave()` is left freely.
 *
 * On a page that needs the portal session, a sign-out always wins over the
 * question: signed out → leave at once; signed out while the doctor is being
 * asked (e.g. they walked away from the prompt and the idle timeout ended the
 * session) → go to the sign-in page. Patient details are never held on screen
 * behind a prompt. (The session service does not redirect on its own while a
 * navigation — the one waiting on the prompt — is under way.)
 *
 * Usage: `{ path: 'prescriptions/new', canDeactivate: [unsavedChangesGuard], … }`.
 */
export const unsavedChangesGuard: CanDeactivateFn<Partial<CanLeave> | null> = (
  component,
  currentRoute,
) => {
  if (typeof component?.canLeave !== 'function') return true;
  const signedInOnly = needsSignIn(currentRoute);
  const auth = inject(StaffAuthService);
  if (signedInOnly && !auth.isAuthenticated()) return true;
  const answer = component.canLeave();
  if (typeof answer === 'boolean' || !signedInOnly) return answer;
  return answerUnlessSignedOut(answer, auth);
};

/** Whether any route on the way to this one is guarded (i.e. needs a session). */
function needsSignIn(route: ActivatedRouteSnapshot | null | undefined): boolean {
  return (route?.pathFromRoot ?? []).some((r) => {
    const cfg = r.routeConfig;
    return !!(cfg?.canActivate?.length || cfg?.canActivateChild?.length || cfg?.canMatch?.length);
  });
}

/**
 * The doctor's answer — unless the session ends first, in which case the
 * navigation is redirected to the sign-in page (remembering where they were
 * when the sign-out was involuntary, as the session service would).
 */
function answerUnlessSignedOut(
  answer: Promise<boolean>,
  auth: StaffAuthService,
): Promise<boolean | UrlTree> {
  const router = inject(Router);
  const injector = inject(Injector);
  const loginUrl = inject(SESSION_TIMEOUT_CONFIG, { optional: true })?.loginUrl ?? '/auth/login';
  return new Promise<boolean | UrlTree>((resolve) => {
    let settled = false;
    // Effects first run asynchronously, so `watch` is assigned before `settle` can run.
    const settle = (result: boolean | UrlTree): void => {
      if (settled) return;
      settled = true;
      watch.destroy();
      resolve(result);
    };
    const watch: EffectRef = effect(
      () => {
        if (auth.isAuthenticated()) return;
        untracked(() => {
          if (peekSessionNotice()) auth.rememberRedirect(router.url);
          settle(router.parseUrl(loginUrl));
        });
      },
      { injector },
    );
    answer.then(settle, () => settle(false));
  });
}

/**
 * A promise-based "Leave without saving?" prompt backed by the component's own
 * `<sd-confirm-dialog>`: `ask()` opens it and resolves with the doctor's answer.
 *
 * Usage:
 * ```ts
 * protected readonly leavePrompt = new LeavePrompt();
 * canLeave() { return this.dirty() ? this.leavePrompt.ask() : true; }
 * ```
 * ```html
 * <sd-confirm-dialog [open]="leavePrompt.open()" title="Leave without saving?"
 *   (confirm)="leavePrompt.answer(true)" (cancel)="leavePrompt.answer(false)" />
 * ```
 */
export class LeavePrompt {
  private readonly _open = signal(false);
  /** Whether the prompt is showing. */
  readonly open = this._open.asReadonly();
  private resolve: ((ok: boolean) => void) | null = null;

  /** Open the prompt; resolves true for "leave", false for "stay". */
  ask(): Promise<boolean> {
    // A newer question supersedes an unanswered one.
    this.resolve?.(false);
    this._open.set(true);
    return new Promise<boolean>((resolve) => {
      this.resolve = resolve;
    });
  }

  /** Close the prompt with the doctor's answer. */
  answer(ok: boolean): void {
    const resolve = this.resolve;
    this.resolve = null;
    this._open.set(false);
    resolve?.(ok);
  }
}
