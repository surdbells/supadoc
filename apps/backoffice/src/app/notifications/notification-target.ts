import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  type Router,
} from '@angular/router';
import type { StaffNotificationDto } from '@supadoc/models';

/** Where a notification leads in the console: a route, plus a section of that page. */
export interface NotificationTarget {
  readonly path: string;
  /** The id of the section to bring into view (also the URL's fragment). */
  readonly fragment?: string;
}

/** The patient page's Lab requests heading (patients/patient-detail.ts). */
export const LAB_SECTION_ID = 'bo-patient-labs-title';

/**
 * The staff notifications the API sends to back-office roles, and where each
 * one's `link` may lead (the API stores a console path; nothing else is in the
 * payload). A link opens only when it is one of these routes, for its own
 * type, and the user's permissions open that page; anything else (a doctor
 * portal path, an unknown type) shows no link rather than a guess.
 *  - application: a doctor application to review (ApplicationNotifier)
 *  - onboarding / doctor_noshow: a doctor's profile (DoctorOnboardingService, PastAppointmentCloser)
 *  - lab: a result nobody reviewed in 7 days, on the patient's page (LabRequestNotifier)
 */
const RULES: readonly {
  readonly types: readonly string[];
  readonly path: RegExp;
  readonly permission: string;
  readonly fragment?: string;
}[] = [
  {
    types: ['application'],
    path: /^\/applications\/[\w-]+$/,
    permission: 'specialists.manage',
  },
  {
    types: ['onboarding', 'doctor_noshow'],
    path: /^\/specialists\/[\w-]+$/,
    permission: 'specialists.manage',
  },
  {
    types: ['lab'],
    path: /^\/patients\/[\w-]+$/,
    permission: 'monitoring.view',
    fragment: LAB_SECTION_ID,
  },
];

/** Where this notification leads for someone with these permissions, or null for no link. */
export function notificationTarget(
  n: Pick<StaffNotificationDto, 'type' | 'link'>,
  can: (permission: string) => boolean,
): NotificationTarget | null {
  const link = n.link?.trim();
  if (!link) return null;
  const rule = RULES.find((r) => r.types.includes(n.type) && r.path.test(link));
  if (!rule || !can(rule.permission)) return null;
  return rule.fragment
    ? { path: link, fragment: rule.fragment }
    : { path: link };
}

const ICONS: Record<string, string> = {
  application: 'clipboard-list',
  onboarding: 'stethoscope',
  doctor_noshow: 'calendar-x',
  lab: 'flask-conical',
};

/** The icon beside a notification of this type. */
export function notificationIcon(type: string): string {
  return ICONS[type] ?? 'bell';
}

/** What a section still loading on the page says about itself. */
const LOADING = '[aria-busy="true"]';

/** The user taking over the scroll (not the scroll events our own jumps fire). */
const USER_SCROLL = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/**
 * Once the navigation that is starting lands, bring the section `id` into view
 * as soon as the page has rendered it (pages load their data first), and again
 * whenever the page changes until nothing on it is still loading (`aria-busy`),
 * so a section above that fills in late can't push it back off screen. Gives
 * up after `timeoutMs`, when the user scrolls, clicks or types (never fighting
 * them), or when that navigation fails or another one starts. `outside` runs
 * the watch outside Angular's zone (NgZone.runOutsideAngular), so the app still
 * counts as stable while it waits.
 */
export function revealOnArrival(
  router: Router,
  doc: Document,
  id: string,
  outside: (fn: () => void) => void = (fn) => fn(),
  timeoutMs = 10_000,
): void {
  const win = doc.defaultView;
  let landed = false;
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Scrolls to the section if it is there; true once that place is final. */
  const reveal = (): boolean => {
    const el = doc.getElementById(id);
    el?.scrollIntoView?.({ block: 'start' });
    return !!el && !doc.querySelector(LOADING);
  };
  const sub = router.events.subscribe((e) => {
    if (e instanceof NavigationEnd && !landed) {
      landed = true;
      if (reveal() || typeof MutationObserver === 'undefined') return stop();
      outside(() => {
        observer = new MutationObserver(() => {
          if (reveal()) stop();
        });
        // A loader leaves either by being removed or by dropping aria-busy.
        observer.observe(doc.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-busy'],
        });
        for (const type of USER_SCROLL) {
          win?.addEventListener(type, stop, { capture: true, passive: true });
        }
        timer = setTimeout(stop, timeoutMs);
      });
    } else if (
      e instanceof NavigationCancel ||
      e instanceof NavigationError ||
      (e instanceof NavigationStart && landed)
    ) {
      stop();
    }
  });
  function stop(): void {
    sub.unsubscribe();
    observer?.disconnect();
    clearTimeout(timer);
    for (const type of USER_SCROLL) {
      win?.removeEventListener(type, stop, { capture: true });
    }
  }
}
