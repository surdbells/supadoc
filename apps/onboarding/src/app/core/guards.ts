import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { apiErrorMessage } from '@supadoc/data-access';
import type { ApplicationStepKey } from '@supadoc/models';
import { ApplicantSession } from './applicant-session';
import { ApplicationDraftStore } from './application-draft.store';
import { NOTICE, Notices } from './notices';
import { stepIndex, stepUrl } from './wizard-steps';

/**
 * Wizard steps (spec §6.3):
 * - `personal` needs a licence route (chosen locally, or the draft's);
 * - later steps need a live draft; a step after `draft.next_step` sends the
 *   applicant to `next_step`;
 * - a missing or dead token goes to the Resume modal with a notice.
 */
export function wizardStepGuard(step: ApplicationStepKey | 'review'): CanActivateFn {
  return async () => {
    const store = inject(ApplicationDraftStore);
    const session = inject(ApplicantSession);
    const router = inject(Router);
    const notices = inject(Notices);
    const toResume = (message: string) => {
      notices.set('resume', message);
      return router.parseUrl('/?dialog=resume');
    };

    let draft = null;
    if (session.draftToken()) {
      try {
        draft = await store.ensureLoaded();
      } catch (err) {
        return toResume(apiErrorMessage(err, "We couldn't load your application. Please try again."));
      }
      if (!draft) return toResume(NOTICE.sessionEnded);
    }

    if (step === 'personal') {
      return draft || store.hasRoute() ? true : router.parseUrl('/apply');
    }
    if (!draft) return toResume(NOTICE.sessionEnded);
    if (stepIndex(step) > stepIndex(draft.next_step)) return router.parseUrl(stepUrl(draft.next_step));
    return true;
  };
}

/** /apply/submitted needs the submission in memory (a reload goes home). */
export const submittedGuard: CanActivateFn = () =>
  inject(ApplicationDraftStore).submission() ? true : inject(Router).parseUrl('/');

/** /status and /status/respond need a track access token. */
export const trackSessionGuard: CanActivateFn = () =>
  inject(ApplicantSession).accessToken() ? true : inject(Router).parseUrl('/?dialog=track');
