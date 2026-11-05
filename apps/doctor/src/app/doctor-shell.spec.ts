import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { API_CONFIG, DoctorApi } from '@supadoc/data-access';
import { provideSupadocIcons } from '@supadoc/ui';
import { DoctorClock } from './doctor-clock';
import { DoctorShell } from './doctor-shell';
import { DoctorSignOut } from './sign-out';
import { DoctorStandingStore } from './standing/doctor-standing.store';
import { DoctorTimeZoneBanner } from './time-zone/time-zone-banner';

/** The time-zone banner has its own spec; here it only takes its place. */
@Component({ selector: 'doc-time-zone-banner', template: '' })
class TimeZoneBannerStub {}

const UNREAD_URL = 'http://api.test/api/me/notifications/unread';

describe('DoctorShell', () => {
  let fixture: ComponentFixture<DoctorShell>;
  let el: HTMLElement;
  let http: HttpTestingController;

  /** The header bell's unread dot (absent with nothing unread). */
  const dot = () => el.querySelector('a[aria-label="Notifications"] span');

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [DoctorShell],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        {
          provide: StaffAuthService,
          useValue: {
            loadMe: () => Promise.resolve(null),
            displayName: signal('Ada Obi'),
          },
        },
        {
          provide: DoctorStandingStore,
          useValue: {
            load: () => Promise.resolve(null),
            code: signal(null),
            onboarding: signal(null),
          },
        },
        {
          provide: DoctorClock,
          useValue: {
            retry: () => Promise.resolve(),
            profile: () => null,
            apply: () => undefined,
          },
        },
        { provide: DoctorApi, useValue: { assetUrl: () => null } },
        { provide: DoctorSignOut, useValue: { ask: () => Promise.resolve(false) } },
      ],
    });
    TestBed.overrideComponent(DoctorShell, {
      remove: { imports: [DoctorTimeZoneBanner] },
      add: { imports: [TimeZoneBannerStub] },
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(DoctorShell);
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  afterEach(() => fixture?.destroy());

  it('reads the bell’s unread count as a background read (X-SD-Passive), so it never extends the idle session', () => {
    const req = http.expectOne(UNREAD_URL);
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('X-SD-Passive')).toBe('1');
    req.flush({ status: 'success', message: 'OK', data: { count: 3 } });
    fixture.detectChanges();
    expect(dot()).not.toBeNull();
    http.verify(); // no other request went out from the shell
  });

  it('shows no dot when nothing is unread, or when the count can’t be read', () => {
    http.expectOne(UNREAD_URL).flush({ status: 'success', message: 'OK', data: { count: 0 } });
    fixture.detectChanges();
    expect(dot()).toBeNull();

    // A second shell whose read fails: still no dot, and no error escapes.
    const again = TestBed.createComponent(DoctorShell);
    again.detectChanges();
    http.expectOne(UNREAD_URL).flush('down', { status: 503, statusText: 'Service Unavailable' });
    again.detectChanges();
    expect(again.nativeElement.querySelector('a[aria-label="Notifications"] span')).toBeNull();
    again.destroy();
    http.verify();
  });
});
