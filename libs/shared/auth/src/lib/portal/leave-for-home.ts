import { DOCUMENT } from '@angular/common';
import { inject, InjectionToken } from '@angular/core';
import type { Router } from '@angular/router';
import { publicHomeUrl } from './portal-links';

/** The page's `Location` (a token so tests can stand in for it). */
export const PAGE_LOCATION = new InjectionToken<Location>(
  'SUPADOC_PAGE_LOCATION',
  {
    providedIn: 'root',
    factory: () => inject(DOCUMENT).location,
  },
);

/**
 * The staff logo: leave for the public homepage (another site) without signing
 * out. First an in-app navigation to the app's empty route `go/home`
 * (`{ path: 'go/home', children: [] }`, with `skipLocationChange`), so the
 * page being left asks about unsaved edits (its `unsavedChangesGuard`) and is
 * destroyed before the unload — no second, browser-native "Leave site?" from
 * its `beforeunload`. Staying on the page (the user chose to) leaves nothing to
 * do. Then a new history entry for the homepage, so Back returns to the portal.
 */
export async function leaveForHome(
  router: Router,
  loc: Location,
): Promise<void> {
  const left = await router.navigateByUrl('/go/home', {
    skipLocationChange: true,
  });
  if (left) loc.assign(publicHomeUrl(loc));
}
