import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  APPLICANT_DRAFT_PREFIX,
  APPLICANT_TRACK_PREFIXES,
  apiErrorCode,
  apiErrorFields,
} from '@supadoc/data-access';
import { catchError, throwError } from 'rxjs';
import { ApplicantSession } from './applicant-session';
import { TrackStore } from './track.store';

/** Answers on a draft URL that mean the draft token is dead: drop it. */
const DRAFT_DEAD: ReadonlyArray<[number, string | null]> = [
  [401, 'applicant_token_invalid'],
  [404, 'draft_not_found'],
  [409, 'draft_submitted'],
];

/**
 * Adds the applicant's Bearer token by URL prefix: the draft token for
 * `…/drafts/current…`, the track access token for the status endpoints, and
 * nothing for anything else (config, drafts, resume, track/start…).
 *
 * On a dead draft token (401 applicant_token_invalid, 404 draft_not_found,
 * 409 draft_submitted) it forgets the token; draft_submitted also prefills the
 * Track modal with the reference and opens it. A 401 on a track URL drops the
 * access token. Registered innermost, so it sees the raw HttpErrorResponse.
 */
export const applicantTokenInterceptor: HttpInterceptorFn = (req, next) => {
  const session = inject(ApplicantSession);
  const track = inject(TrackStore);
  const router = inject(Router);

  const isDraft = req.url.includes(APPLICANT_DRAFT_PREFIX);
  const isTrack = !isDraft && APPLICANT_TRACK_PREFIXES.some((p) => req.url.includes(p));
  const token = isDraft ? session.draftToken() : isTrack ? session.accessToken() : null;
  const outgoing = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(outgoing).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse) {
        const code = apiErrorCode(err);
        if (isDraft && DRAFT_DEAD.some(([status, c]) => err.status === status && code === c)) {
          session.setDraftToken(null);
          if (code === 'draft_submitted') {
            track.prefill(apiErrorFields(err)['reference'] ?? null);
            void router.navigateByUrl('/?dialog=track');
          }
        } else if (isDraft && err.status === 401) {
          session.setDraftToken(null);
        }
        if (isTrack && err.status === 401) session.setAccessToken(null);
      }
      return throwError(() => err);
    }),
  );
};
