import { InjectionToken } from '@angular/core';

/**
 * Provided by the consultation call page: the portal's sharing components shown
 * during the call (the cockpit's request and share dialogs, and the record's
 * Document sharing tab with every dialog it opens) act in place instead of
 * linking to another page, which would end the call. Absent everywhere else, so
 * the standalone pages keep their links.
 */
export interface CallInPlace {
  /** Bring the call's Document sharing tab forward (opening it if needed) and focus it. */
  showSharing(): void;
}

export const CALL_IN_PLACE = new InjectionToken<CallInPlace>('CALL_IN_PLACE');
