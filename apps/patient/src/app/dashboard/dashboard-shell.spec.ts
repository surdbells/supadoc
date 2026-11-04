import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { AuthService } from '@supadoc/auth';
import { API_CONFIG } from '@supadoc/data-access';
import type { PatientProfileDto, TimeZoneSource } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DashboardShell } from './dashboard-shell';

const BASE = 'http://api.test';

@Component({ template: '<p>page</p>' })
class Page {}

const realResolved = Intl.DateTimeFormat.prototype.resolvedOptions;

/** Makes this device report `tz` as its zone. */
function deviceZone(tz: string) {
  return vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...realResolved.call(this), timeZone: tz };
  });
}

function me(id: string, source: TimeZoneSource | null): PatientProfileDto {
  return {
    id,
    email: 'ada@example.test',
    first_name: 'Ada',
    last_name: 'Obi',
    phone: null,
    phone_verified: false,
    date_of_birth: null,
    gender: null,
    address: null,
    avatar_url: null,
    created_at: '2026-01-01T00:00:00Z',
    timezone: 'Africa/Lagos',
    timezone_source: source,
  };
}

describe('DashboardShell', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  const flushStart = (profile: PatientProfileDto) => {
    http.expectOne(`${BASE}/api/portal/me`).flush({ status: 'success', message: 'OK', data: profile });
    http
      .expectOne((r) => r.url === `${BASE}/api/portal/notifications`)
      .flush({ status: 'success', message: 'OK', data: [], meta: { unread: 0, page: 1, per_page: 1, total: 0, total_pages: 1 } });
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          {
            path: 'dashboard',
            component: DashboardShell,
            children: [
              { path: '', component: Page },
              { path: 'call/:id', component: Page, data: { immersive: true } },
            ],
          },
        ]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
        { provide: AuthService, useValue: { logout: async () => undefined, isAuthenticated: () => true } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  it('is full screen on an immersive route (the call): no sidebar, header or padding', async () => {
    await harness.navigateByUrl('/dashboard');
    flushStart(me('p-1', 'manual'));
    harness.detectChanges();
    const shell = harness.fixture.nativeElement as HTMLElement;
    expect(shell.querySelector('pat-dashboard-shell aside')).toBeTruthy();
    expect(shell.querySelector('pat-dashboard-shell header')).toBeTruthy();
    expect(shell.querySelector('main')?.className).toContain('px-5');

    await harness.navigateByUrl('/dashboard/call/ap-1');
    harness.detectChanges();
    expect(shell.querySelector('pat-dashboard-shell aside')).toBeNull();
    expect(shell.querySelector('pat-dashboard-shell header')).toBeNull();
    expect(shell.querySelector('main')?.className).not.toContain('px-5');
    expect(shell.querySelector('main p')?.textContent).toBe('page');

    await harness.navigateByUrl('/dashboard');
    harness.detectChanges();
    expect(shell.querySelector('pat-dashboard-shell aside')).toBeTruthy();
  });

  it("saves this device's zone once the profile loads, while the patient has none", async () => {
    deviceZone('America/Chicago');
    await harness.navigateByUrl('/dashboard');
    flushStart(me('p-2', null));
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === `${BASE}/api/portal/me/timezone`);
    expect(put.request.body).toEqual({ timezone: 'America/Chicago', source: 'auto' });
    put.flush({ status: 'success', message: 'OK', data: { timezone: 'America/Chicago', timezone_source: 'auto', changed: true } });
  });

  it('never overwrites a zone that is set', async () => {
    deviceZone('America/Chicago');
    await harness.navigateByUrl('/dashboard');
    flushStart(me('p-3', 'manual'));
    http.expectNone((r) => r.url.endsWith('/api/portal/me/timezone'));

  });

  it('does not save UTC (a VPN or privacy browser)', async () => {
    deviceZone('UTC');
    await harness.navigateByUrl('/dashboard');
    flushStart(me('p-4', null));
    http.expectNone((r) => r.url.endsWith('/api/portal/me/timezone'));
  });
});
