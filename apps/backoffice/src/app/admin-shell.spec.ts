import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { PAGE_LOCATION } from '@supadoc/auth/portal';
import { DialogService, provideSupadocIcons } from '@supadoc/ui';
import { AdminShell } from './admin-shell';
import { ApplicationsQueue } from './applications/applications-queue';
import { NotificationBell } from './notifications/notification-bell';
import { ReviewQueue } from './specialists/review-queue';

/** The back office at backoffice.dosthq.com (leaving is recorded, not done). */
const page = {
  protocol: 'https:',
  hostname: 'backoffice.dosthq.com',
  origin: 'https://backoffice.dosthq.com',
  assign: vi.fn(),
};

/** The bell has its own behaviour; here it only takes its place. */
@Component({ selector: 'bo-notification-bell', template: '' })
class BellStub {}

describe('AdminShell — logo', () => {
  let fixture: ComponentFixture<AdminShell>;
  let el: HTMLElement;

  beforeEach(() => {
    const queue = { count: signal(0), refresh: () => undefined };
    TestBed.configureTestingModule({
      imports: [AdminShell],
      providers: [
        provideRouter([]),
        { provide: PAGE_LOCATION, useValue: page },
        provideSupadocIcons(),
        {
          provide: StaffAuthService,
          useValue: {
            loadMe: () => Promise.resolve(null),
            displayName: signal('Ada Admin'),
            roles: signal(['super_admin']),
            hasPermission: () => true,
            hasRole: () => false,
          },
        },
        { provide: ReviewQueue, useValue: queue },
        { provide: ApplicationsQueue, useValue: queue },
        {
          provide: DialogService,
          useValue: { confirm: () => Promise.resolve({ confirmed: false }) },
        },
      ],
    });
    TestBed.overrideComponent(AdminShell, {
      remove: { imports: [NotificationBell] },
      add: { imports: [BellStub] },
    });
    fixture = TestBed.createComponent(AdminShell);
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  afterEach(() => fixture.destroy());

  it('links to the public homepage (sidebar with the Admin chip, and the mobile header)', () => {
    const logos = Array.from(
      el.querySelectorAll<HTMLAnchorElement>('a[aria-label="VideoMed home"]'),
    );
    expect(logos).toHaveLength(2);
    expect(
      logos.some(
        (a) => a.querySelector('.sd-chip')?.textContent?.trim() === 'Admin',
      ),
    ).toBe(true);
    for (const a of logos)
      expect(a.getAttribute('href')).toBe(
        'https://patient.dosthq.com/?from=admin',
      );
  });

  it('a plain click leaves through go/home, without a history entry for it, then for the homepage', async () => {
    const nav = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    el.querySelector<HTMLAnchorElement>(
      'a[aria-label="VideoMed home"]',
    )?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(nav).toHaveBeenCalledWith('/go/home', {
      skipLocationChange: true,
      state: { leftFrom: expect.any(String) },
    });
    await Promise.resolve();
    expect(page.assign).toHaveBeenCalledWith(
      'https://patient.dosthq.com/?from=admin',
    );
  });
});
