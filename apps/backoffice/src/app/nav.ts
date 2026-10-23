import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';

export interface NavItem {
  readonly label: string;
  readonly icon: string;
  readonly link: string;
  /** Shown to staff holding this permission (ignored when `allowed` is set). */
  readonly permission: string;
  /** A rule wider than one permission (the dashboard). */
  readonly allowed?: (auth: StaffAuthService) => boolean;
  /**
   * The count shown next to this item: `review` — doctors waiting for review
   * (profiles, change requests, documents); `applications` — doctor
   * applications that need action.
   */
  readonly badge?: NavBadge;
}

export type NavBadge = 'review' | 'applications';

/** The counts behind the nav badges (each 0 for someone who can't act on it). */
export type NavBadgeCounts = Readonly<Record<NavBadge, number>>;

/** The count an item shows (0 hides its pill). */
export function badgeCount(item: NavItem, counts: NavBadgeCounts): number {
  return item.badge ? Math.max(0, counts[item.badge] || 0) : 0;
}

/** What a badge's number means, for its title and screen readers. */
export function badgeLabel(badge: NavBadge, n: number): string {
  return badge === 'review'
    ? `${n} ${n === 1 ? 'item' : 'items'} waiting for review`
    : `${n} ${n === 1 ? 'application needs' : 'applications need'} action`;
}

/** The mobile menu button's words: every waiting count, or nothing. */
export function waitingSummary(counts: NavBadgeCounts): string {
  return (['review', 'applications'] as const)
    .filter((b) => counts[b] > 0)
    .map((b) => badgeLabel(b, counts[b]))
    .join(', ');
}

/**
 * The permissions that each unlock part of the dashboard (the API trims the
 * payload to those parts — AdminDashboardService::PARTS).
 */
const DASHBOARD_PERMISSIONS = [
  'monitoring.view',
  'appointments.view',
  'specialists.manage',
  'payouts.manage',
  'support.manage',
];

/** Permissions only back-office staff hold — mirrors AdminDashboardService::BACK_OFFICE_PERMISSIONS. */
const BACK_OFFICE_PERMISSIONS = [
  'monitoring.view',
  'specialists.manage',
  'payouts.manage',
  'support.manage',
  'staff.manage',
  'settings.manage',
  'appointments.update',
  'appointments.create',
];

/**
 * Who may open the dashboard: anyone with a permission one of its parts needs,
 * except a doctor login with no back-office permission (its `appointments.view`
 * is for its own visits — the API refuses it the dashboard).
 */
export function canOpenDashboard(auth: StaffAuthService): boolean {
  if (!DASHBOARD_PERMISSIONS.some((p) => auth.hasPermission(p))) return false;
  return !auth.hasRole('doctor') || BACK_OFFICE_PERMISSIONS.some((p) => auth.hasPermission(p));
}

export const NAV: readonly NavItem[] = [
  { label: 'Dashboard', icon: 'layout-dashboard', link: '/dashboard', permission: 'monitoring.view', allowed: canOpenDashboard },
  { label: 'Appointments', icon: 'calendar-days', link: '/appointments', permission: 'appointments.view' },
  { label: 'Analytics', icon: 'chart-column', link: '/analytics', permission: 'monitoring.view' },
  { label: 'Monitoring', icon: 'activity', link: '/monitoring', permission: 'monitoring.view' },
  { label: 'Patients', icon: 'user-round', link: '/patients', permission: 'monitoring.view' },
  { label: 'Specialists', icon: 'stethoscope', link: '/specialists', permission: 'specialists.manage', badge: 'review' },
  { label: 'Applications', icon: 'clipboard-list', link: '/applications', permission: 'specialists.manage', badge: 'applications' },
  { label: 'Staff & roles', icon: 'users', link: '/staff', permission: 'staff.manage' },
  { label: 'Payouts', icon: 'wallet', link: '/payouts', permission: 'payouts.manage' },
  { label: 'Support', icon: 'headphones', link: '/support', permission: 'support.manage' },
  { label: 'Pricing', icon: 'banknote', link: '/pricing', permission: 'settings.manage' },
  { label: 'Prescription rules', icon: 'scroll-text', link: '/prescription-rules', permission: 'settings.manage' },
  { label: 'Reference data', icon: 'list', link: '/reference-data', permission: 'settings.manage' },
  { label: 'Audit log', icon: 'history', link: '/audit', permission: 'monitoring.view' },
];

export function canOpen(auth: StaffAuthService, item: NavItem): boolean {
  return item.allowed ? item.allowed(auth) : auth.hasPermission(item.permission);
}

/** The first page in the nav this user may open — undefined when there is none. */
export function firstNavLink(auth: StaffAuthService): string | undefined {
  return NAV.find((item) => canOpen(auth, item))?.link;
}

/**
 * Account settings: open to every signed-in staff user, so always a safe
 * place to land.
 */
const FALLBACK_LANDING = '/settings';

/** Where this user's console "home" is: their first nav page, else Account settings. */
export function landingLink(auth: StaffAuthService): string {
  return firstNavLink(auth) ?? FALLBACK_LANDING;
}

/**
 * For the console's root (`/`, where a refused page also sends the user):
 * the first page this user may open — so a role without the dashboard never
 * bounces between `/` and a page that turns it away. (Links inside the app
 * use {@link landingLink} directly, so leaving a page with unsaved edits
 * asks only once rather than again on this redirect.)
 */
export const landingGuard: CanActivateFn = () => {
  const auth = inject(StaffAuthService);
  return inject(Router).parseUrl(landingLink(auth));
};

/** The dashboard route: {@link canOpenDashboard}, else the user's landing page. */
export const dashboardGuard: CanActivateFn = () => {
  const auth = inject(StaffAuthService);
  const router = inject(Router);
  if (!auth.isAuthenticated()) return router.parseUrl('/auth/login');
  if (canOpenDashboard(auth)) return true;
  return router.parseUrl(landingLink(auth));
};
