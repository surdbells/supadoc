import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  NgZone,
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { IconComponent } from '@supadoc/ui';
import { FOCUS_RING } from '../shared/layout';
import { UnreadNotifications } from './unread-notifications';

/** How often the bell re-reads the unread count while the tab is visible. */
export const BELL_POLL_MS = 60_000;

/** The bell's accessible name: "Notifications", or "Notifications, 3 unread". */
export function bellLabel(unread: number): string {
  return unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
}

/** The badge's text (a number, so it never relies on colour): "3", or "99+". */
export function bellBadge(unread: number): string {
  return unread > 99 ? '99+' : String(unread);
}

/**
 * The header bell: opens Notifications and shows how many are unread. Reads
 * the count on start, every minute while the tab is visible and whenever the
 * window regains focus; stops for good when the session ends.
 */
@Component({
  selector: 'bo-notification-bell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, IconComponent],
  template: `
    <a
      routerLink="/notifications"
      routerLinkActive="bg-haze !text-cerulean-dark"
      ariaCurrentWhenActive="page"
      class="relative flex size-11 shrink-0 items-center justify-center rounded-full text-ink transition-colors hover:bg-frost/40 hover:text-cerulean ${FOCUS_RING}"
      [attr.aria-label]="label()"
    >
      <sd-icon name="bell" [size]="22" />
      @if (count() > 0) {
        <span
          class="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-pill bg-alert-ink px-1 font-sans text-[11px] font-semibold leading-none text-white ring-2 ring-glacier"
          aria-hidden="true"
          >{{ badge() }}</span
        >
      }
    </a>
  `,
})
export class NotificationBell {
  private readonly unread = inject(UnreadNotifications);

  protected readonly count = this.unread.count;
  protected readonly badge = computed(() => bellBadge(this.count()));
  protected readonly label = computed(() => bellLabel(this.count()));

  constructor() {
    const auth = inject(StaffAuthService);
    const zone = inject(NgZone);
    const doc = inject(DOCUMENT);
    const win = doc.defaultView;
    const refresh = () => this.unread.refresh();
    // The timer lives outside Angular's zone (so the app still counts as
    // stable); each read runs inside it. A hidden tab skips its turn; coming
    // back (focus) reads at once.
    const timer = zone.runOutsideAngular(() =>
      setInterval(() => {
        if (!doc.hidden) zone.run(refresh);
      }, BELL_POLL_MS),
    );
    win?.addEventListener('focus', refresh);
    const stop = () => {
      clearInterval(timer);
      win?.removeEventListener('focus', refresh);
    };
    inject(DestroyRef).onDestroy(stop);
    effect(() => {
      if (!auth.isAuthenticated()) stop();
    });
    refresh();
  }
}
