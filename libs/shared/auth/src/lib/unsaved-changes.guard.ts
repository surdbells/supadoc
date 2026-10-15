import { effect, EffectRef, inject, Injector, untracked } from '@angular/core';
import type { ActivatedRouteSnapshot, CanDeactivateFn, UrlTree } from '@angular/router';
import { Router } from '@angular/router';
import { DialogService, LeaveCopy } from '@supadoc/ui';
import { SESSION_AUTH, SessionAuth } from './session/session-auth';
import { peekSessionNotice } from './session/session-notice';
import { SESSION_TIMEOUT_CONFIG } from './session/session-timeout.service';

/** A routed page (or panel) that decides itself whether it may be left. */
export interface CanLeave {
  /**
   * True when it is fine to leave now. With unsaved changes it may ask first
   * (e.g. `inject(DialogService).confirmLeave()`) and resolve with the answer.
   */
  canLeave(): boolean | Promise<boolean>;
}

/** A routed page that only reports whether it holds unsaved work. */
export interface HasUnsavedChanges {
  /** True while leaving would lose something. The guard then asks with the standard prompt. */
  hasUnsavedChanges(): boolean;
  /** Copy for that prompt (defaults: "Leave without saving?" / "Keep editing"). */
  leaveCopy?: LeaveCopy | (() => LeaveCopy);
}

/** What `unsavedChangesGuard` accepts: a page implementing either contract (or neither). */
export type LeaveGuarded = Partial<CanLeave> & Partial<HasUnsavedChanges>;

/**
 * Route guard asking before the router leaves a page with unsaved work — its
 * own back link, the sidebar, the browser Back button. The page either
 * implements `canLeave()` (and asks itself), or `hasUnsavedChanges()` (and the
 * guard asks with `DialogService.confirmLeave(leaveCopy)`). A page with
 * neither is left freely.
 *
 * Works in every portal: it reads the session through `SESSION_AUTH` (provided
 * by `provideSessionTimeout`). On a page that needs a session, a sign-out
 * always wins over the question: signed out → leave at once; signed out while
 * the person is being asked (e.g. they walked away and the idle timeout ended
 * the session) → the prompt closes and the navigation goes to the sign-in page
 * (remembering where they were after an involuntary sign-out). Health details
 * are never held on screen behind a prompt. Pages reachable without a session
 * (a guest or in-call link) keep asking.
 *
 * Usage:
 * ```ts
 * { path: 'profile', component: MyProfile, canDeactivate: [unsavedChangesGuard] }
 *
 * export class MyProfile implements HasUnsavedChanges {
 *   hasUnsavedChanges() { return this.editing() && this.medicalChanged(); }
 *   readonly leaveCopy = { title: 'Discard your changes?', message: "Edits to your medical history won't be saved." };
 * }
 * ```
 */
export const unsavedChangesGuard: CanDeactivateFn<LeaveGuarded | null> = (component, currentRoute) => {
  const ask = questionFor(component);
  if (!ask) return true;
  const session = inject(SESSION_AUTH, { optional: true });
  const signedInOnly = session !== null && needsSignIn(currentRoute);
  if (signedInOnly && !session.isAuthenticated()) return true;
  const answer = ask();
  if (typeof answer === 'boolean' || !signedInOnly) return answer;
  return answerUnlessSignedOut(answer, session);
};

/** How to ask this page, or null when it never needs asking. */
function questionFor(component: LeaveGuarded | null): (() => boolean | Promise<boolean>) | null {
  if (!component) return null;
  if (typeof component.canLeave === 'function') return () => component.canLeave?.() ?? true;
  if (typeof component.hasUnsavedChanges === 'function') {
    const dialogs = inject(DialogService);
    return () => {
      if (!component.hasUnsavedChanges?.()) return true;
      const copy = typeof component.leaveCopy === 'function' ? component.leaveCopy() : component.leaveCopy;
      return dialogs.confirmLeave(copy ?? {});
    };
  }
  return null;
}

/** Whether any route on the way to this one is guarded (i.e. needs a session). */
function needsSignIn(route: ActivatedRouteSnapshot | null | undefined): boolean {
  return (route?.pathFromRoot ?? []).some((r) => {
    const cfg = r.routeConfig;
    return !!(cfg?.canActivate?.length || cfg?.canActivateChild?.length || cfg?.canMatch?.length);
  });
}

/**
 * The person's answer — unless the session ends first: then the open prompt is
 * closed and the navigation goes to the sign-in page instead (remembering where
 * they were when the sign-out was involuntary, as the session service would).
 */
function answerUnlessSignedOut(answer: Promise<boolean>, session: SessionAuth): Promise<boolean | UrlTree> {
  const router = inject(Router);
  const injector = inject(Injector);
  const dialogs = inject(DialogService);
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
        if (session.isAuthenticated()) return;
        untracked(() => {
          if (peekSessionNotice()) session.rememberRedirect(router.url);
          settle(router.parseUrl(loginUrl));
          dialogs.dismissAll();
        });
      },
      { injector },
    );
    answer.then(settle, () => settle(false));
  });
}
