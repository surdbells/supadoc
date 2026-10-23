import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import {
  badgeCount,
  badgeLabel,
  canOpen,
  canOpenDashboard,
  dashboardGuard,
  firstNavLink,
  landingGuard,
  NAV,
  waitingSummary,
} from './nav';

/** A signed-in staff user with these roles and permissions (super_admin passes everything). */
function staff(roles: string[], permissions: string[]): StaffAuthService {
  return {
    isAuthenticated: () => true,
    hasRole: (r: string) => roles.includes(r),
    hasPermission: (p: string) => roles.includes('super_admin') || permissions.includes(p),
  } as unknown as StaffAuthService;
}

function runGuard(guard: typeof landingGuard, auth: StaffAuthService): boolean | UrlTree {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: StaffAuthService, useValue: auth }],
  });
  return TestBed.runInInjectionContext(
    () => guard({} as never, {} as never) as boolean | UrlTree,
  );
}

function path(result: boolean | UrlTree): string {
  return result instanceof UrlTree ? TestBed.inject(Router).serializeUrl(result) : String(result);
}

describe('back-office nav rules', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('opens the dashboard for any permission one of its parts needs', () => {
    expect(canOpenDashboard(staff(['admin'], ['monitoring.view']))).toBe(true);
    expect(canOpenDashboard(staff(['staff'], ['support.manage']))).toBe(true);
    expect(canOpenDashboard(staff(['staff'], ['payouts.manage']))).toBe(true);
    expect(canOpenDashboard(staff(['staff'], ['appointments.view']))).toBe(true);
    expect(canOpenDashboard(staff(['super_admin'], []))).toBe(true);
    expect(canOpenDashboard(staff(['staff'], ['settings.manage']))).toBe(false);
  });

  it('keeps a doctor login (appointments.view only) off the dashboard, like the API', () => {
    expect(canOpenDashboard(staff(['doctor'], ['appointments.view']))).toBe(false);
    expect(firstNavLink(staff(['doctor'], ['appointments.view']))).toBe('/appointments');
    expect(canOpenDashboard(staff(['doctor'], ['appointments.view', 'support.manage']))).toBe(true);
  });

  it('lands each role on the first page it may open — never a page that refuses it', () => {
    expect(path(runGuard(landingGuard, staff(['admin'], ['monitoring.view'])))).toBe('/dashboard');
    expect(path(runGuard(landingGuard, staff(['staff'], ['settings.manage'])))).toBe('/pricing');
    expect(path(runGuard(landingGuard, staff(['staff'], ['staff.manage'])))).toBe('/staff');
    expect(path(runGuard(landingGuard, staff(['staff'], [])))).toBe('/settings');
  });

  it('sends someone without dashboard access to their landing page, not back to /', () => {
    expect(runGuard(dashboardGuard, staff(['staff'], ['support.manage']))).toBe(true);
    expect(path(runGuard(dashboardGuard, staff(['staff'], ['settings.manage'])))).toBe('/pricing');
    expect(path(runGuard(dashboardGuard, staff(['doctor'], ['appointments.view'])))).toBe('/appointments');
  });

  it('has no landing for an account with no console page at all', () => {
    expect(firstNavLink(staff(['staff'], []))).toBeUndefined();
  });
});

describe('back-office nav badges', () => {
  const item = (link: string) => {
    const found = NAV.find((n) => n.link === link);
    if (!found) throw new Error(`No nav item ${link}`);
    return found;
  };

  it('puts Applications right after Specialists, for the same reviewers', () => {
    const links = NAV.map((n) => n.link);
    expect(links.indexOf('/applications')).toBe(links.indexOf('/specialists') + 1);
    const apps = item('/applications');
    expect(apps.label).toBe('Applications');
    expect(apps.icon).toBe('clipboard-list');
    expect(apps.permission).toBe('specialists.manage');
    expect(canOpen(staff(['staff'], ['specialists.manage']), apps)).toBe(true);
    expect(canOpen(staff(['staff'], ['support.manage']), apps)).toBe(false);
  });

  it('shows each item its own count: review on Specialists, needs-action on Applications', () => {
    const counts = { review: 4, applications: 2 };
    expect(badgeCount(item('/specialists'), counts)).toBe(4);
    expect(badgeCount(item('/applications'), counts)).toBe(2);
    expect(badgeCount(item('/dashboard'), counts)).toBe(0);
    expect(badgeCount(item('/applications'), { review: 4, applications: 0 })).toBe(0);
  });

  it('says what each count means, and sums both for the mobile menu', () => {
    expect(badgeLabel('review', 1)).toBe('1 item waiting for review');
    expect(badgeLabel('applications', 1)).toBe('1 application needs action');
    expect(badgeLabel('applications', 3)).toBe('3 applications need action');
    expect(waitingSummary({ review: 2, applications: 1 })).toBe('2 items waiting for review, 1 application needs action');
    expect(waitingSummary({ review: 0, applications: 5 })).toBe('5 applications need action');
    expect(waitingSummary({ review: 0, applications: 0 })).toBe('');
  });
});
