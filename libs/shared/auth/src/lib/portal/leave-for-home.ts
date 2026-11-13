import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  InjectionToken,
} from '@angular/core';
import { Router } from '@angular/router';
import type { PortalKind } from '../session/portal-hint';
import { isPlainClick, publicHomeUrl } from './portal-links';

/** The page's `Location` (a token so tests can stand in for it). */
export const PAGE_LOCATION = new InjectionToken<Location>(
  'SUPADOC_PAGE_LOCATION',
  {
    providedIn: 'root',
    factory: () => inject(DOCUMENT).location,
  },
);

/** The in-app route the staff logo leaves through (see {@link leaveForHome}). */
const GO_HOME = '/go/home';
/** Navigation state on the way to `go/home`: the page being left. */
const BACK_STATE = 'leftFrom';

/**
 * The staff logo: leave for the public homepage (another site) without signing
 * out. First an in-app navigation to the app's `go/home` route (showing
 * {@link LeavingHome}, with `skipLocationChange`), so the page being left asks
 * about unsaved edits (its `unsavedChangesGuard`) and is destroyed before the
 * unload — no second, browser-native "Leave site?" from its `beforeunload`.
 * Staying on the page (the user chose to) leaves nothing to do. Then a new
 * history entry for the homepage, naming this portal (`from`), so Back returns
 * to the portal — and if Back restores this very document from the
 * back/forward cache (still on `go/home`), the page left is put back.
 */
export async function leaveForHome(
  router: Router,
  loc: Location,
  from: PortalKind,
  win: Pick<Window, 'addEventListener'> = window,
): Promise<void> {
  const back = router.url;
  const left = await router.navigateByUrl(GO_HOME, {
    skipLocationChange: true,
    state: { [BACK_STATE]: back },
  });
  if (!left) return;
  win.addEventListener(
    'pageshow',
    (e) => {
      if ((e as PageTransitionEvent).persisted && router.url === GO_HOME)
        void router.navigateByUrl(back, { replaceUrl: true });
    },
    { once: true },
  );
  loc.assign(publicHomeUrl(loc, from));
}

/**
 * The `go/home` route's page: shown while the homepage loads (a slow or failed
 * load never leaves a blank portal), with a way to stay.
 */
@Component({
  selector: 'sd-leaving-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main
      class="flex min-h-dvh flex-col items-center justify-center gap-3 bg-glacier px-4 text-center"
    >
      <span class="font-heading text-h4 tracking-tight">
        <span class="text-cerulean">Video</span
        ><span class="text-sage">Med</span>
      </span>
      <p class="font-sans text-body text-ink" role="status">
        Opening the VideoMed home page…
      </p>
      <a
        [href]="back"
        (click)="stay($event)"
        class="rounded-lg px-2 py-1 font-sans text-body font-semibold text-cerulean hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
        >Stay in the portal</a
      >
    </main>
  `,
})
export class LeavingHome {
  private readonly router = inject(Router);
  protected readonly back =
    (this.router.currentNavigation()?.extras.state?.[BACK_STATE] as
      string | undefined) ?? '/';

  protected stay(e: MouseEvent): void {
    if (!isPlainClick(e)) return;
    e.preventDefault();
    void this.router.navigateByUrl(this.back, { replaceUrl: true });
  }
}
