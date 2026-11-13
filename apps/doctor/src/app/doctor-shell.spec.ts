import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { PAGE_LOCATION } from '@supadoc/auth/portal';
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

/** The portal at doctor.dosthq.com (leaving is recorded, not done). */
const page = {
  protocol: 'https:',
  hostname: 'doctor.dosthq.com',
  origin: 'https://doctor.dosthq.com',
  assign: vi.fn(),
};

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
        { provide: PAGE_LOCATION, useValue: page },
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

  it('the logo links to the public homepage; a plain click leaves through go/home (unsaved edits asked first)', async () => {
    page.assign.mockClear();
    http
      .expectOne(UNREAD_URL)
      .flush({ status: 'success', message: 'OK', data: { count: 0 } });
    const router = TestBed.inject(Router);
    const nav = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const logos = Array.from(
      el.querySelectorAll<HTMLAnchorElement>('a[aria-label="VideoMed home"]'),
    );
    // The desktop sidebar's (with the Doctor chip) and the mobile header's.
    expect(logos).toHaveLength(2);
    expect(logos[0].textContent).toContain('Doctor');
    for (const a of logos)
      expect(a.getAttribute('href')).toBe(
        'https://patient.dosthq.com/?from=doctor',
      );

    const plain = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    logos[1].dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(nav).toHaveBeenCalledWith('/go/home', {
      skipLocationChange: true,
      state: { leftFrom: expect.any(String) },
    });
    await Promise.resolve();
    expect(page.assign).toHaveBeenCalledWith(
      'https://patient.dosthq.com/?from=doctor',
    );

    // Ctrl/⌘-click: the browser opens the link in a new tab, the app stays put.
    nav.mockClear();
    let preventedByApp: boolean | null = null;
    const stop = (e: Event) => {
      preventedByApp = e.defaultPrevented;
      e.preventDefault(); // jsdom would otherwise try to follow the link
    };
    window.addEventListener('click', stop);
    logos[0].dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ctrlKey: true,
      }),
    );
    window.removeEventListener('click', stop);
    expect(preventedByApp).toBe(false);
    expect(nav).not.toHaveBeenCalled();
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
