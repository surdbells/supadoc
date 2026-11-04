import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { computed, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { AuthService } from '@supadoc/auth';
import { API_CONFIG } from '@supadoc/data-access';
import type { TimeZoneSource } from '@supadoc/models';
import { App } from './app';

const BASE = 'http://api.test';
const ME = `${BASE}/api/portal/me`;
const ZONE = `${BASE}/api/portal/me/timezone`;

const realResolved = Intl.DateTimeFormat.prototype.resolvedOptions;

/** Makes this device report `tz` as its zone. */
function deviceZone(tz: string) {
  return vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...realResolved.call(this), timeZone: tz };
  });
}

const ok = <T>(data: T) => ({ status: 'success', message: 'OK', data });

function profile(source: TimeZoneSource | null) {
  return { id: 'p1', first_name: 'Ada', timezone: source ? 'Europe/London' : 'Africa/Lagos', timezone_source: source };
}

describe('App', () => {
  /** The signed-in patient (the access token's `sub`), or null when signed out. */
  const subject = signal<string | null>(null);
  let http: HttpTestingController;
  let fixture: ComponentFixture<App>;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    subject.set(null);
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        provideIonicAngular(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
        { provide: AuthService, useValue: { subject, isAuthenticated: computed(() => subject() !== null) } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  it('should create the app', async () => {
    fixture = TestBed.createComponent(App);
    await render();
    expect(fixture.componentInstance).toBeTruthy();
    // Signed out: nothing is read.
    http.expectNone(ME);
  });

  it('saves the detected zone once per signed-in patient, only while none is set', async () => {
    deviceZone('America/Chicago');
    fixture = TestBed.createComponent(App);
    await render();

    subject.set('p1');
    await render();
    http.expectOne(ME).flush(ok(profile(null)));
    const put = http.expectOne(ZONE);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ timezone: 'America/Chicago', source: 'auto' });
    put.flush(ok({ timezone: 'America/Chicago', timezone_source: 'auto', changed: true }));

    // Signing out and back in as the same patient doesn't sync again.
    subject.set(null);
    await render();
    subject.set('p1');
    await render();
    http.expectNone(ME);

    // Another patient on this device: their own sync. A zone already set is never overwritten.
    subject.set('p2');
    await render();
    http.expectOne(ME).flush(ok(profile('manual')));
    http.expectNone(ZONE);
  });

  it("doesn't save a zone the device can't vouch for (UTC behind a VPN)", async () => {
    deviceZone('UTC');
    fixture = TestBed.createComponent(App);
    subject.set('p1');
    await render();
    http.expectOne(ME).flush(ok(profile(null)));
    http.expectNone(ZONE);
  });

  it('a failed profile read is retried on the next sign-in', async () => {
    deviceZone('Europe/Berlin');
    fixture = TestBed.createComponent(App);
    subject.set('p1');
    await render();
    http.expectOne(ME).flush({ status: 'error', message: 'Down' }, { status: 503, statusText: 'Unavailable' });
    subject.set(null);
    await render();
    subject.set('p1');
    await render();
    http.expectOne(ME).flush(ok(profile(null)));
    expect(http.expectOne(ZONE).request.body).toEqual({ timezone: 'Europe/Berlin', source: 'auto' });
  });
});
