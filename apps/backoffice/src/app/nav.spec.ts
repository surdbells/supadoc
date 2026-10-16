import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { canOpenDashboard, dashboardGuard, firstNavLink, landingGuard } from './nav';

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
