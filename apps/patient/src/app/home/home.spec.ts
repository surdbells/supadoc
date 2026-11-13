import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AuthService } from '@supadoc/auth';
import { provideSupadocIcons } from '@supadoc/ui';
import { Home } from './home';
import { HomeDiscovery } from './home-discovery';

/** The discovery search has its own spec; here it only takes its place. */
@Component({ selector: 'pat-home-discovery', template: '' })
class DiscoveryStub {}

const enc = encodeURIComponent;
const DOCTOR = `http://localhost:4364`;
const ADMIN = `http://localhost:4362`;

function setCookie(name: string, value: string): void {
  document.cookie = `${name}=${enc(value)}; Path=/`;
}

/**
 * Renders the homepage once — the header is read straight after the first
 * change detection, with nothing awaited: what shows then is what the visitor
 * sees first, so a wrong button would flash.
 */
function render(patientSignedIn: boolean) {
  TestBed.configureTestingModule({
    imports: [Home],
    providers: [
      provideRouter([]),
      provideSupadocIcons(),
      {
        provide: AuthService,
        useValue: { isAuthenticated: signal(patientSignedIn) },
      },
    ],
  });
  TestBed.overrideComponent(Home, {
    remove: { imports: [HomeDiscovery] },
    add: { imports: [DiscoveryStub] },
  });
  const fixture = TestBed.createComponent(Home);
  fixture.detectChanges();
  const header = (fixture.nativeElement as HTMLElement).querySelector(
    'header',
  ) as HTMLElement;
  const text = () => header.textContent?.replace(/\s+/g, ' ') ?? '';
  const dashboards = () =>
    Array.from(
      header.querySelectorAll<HTMLAnchorElement>(
        'a[aria-label^="Go to Dashboard"]',
      ),
    );
  const openMenu = () => {
    header
      .querySelector<HTMLButtonElement>('button[aria-label="Toggle menu"]')
      ?.click();
    fixture.detectChanges();
  };
  return { fixture, header, text, dashboards, openMenu };
}

describe('Home — session-aware header', () => {
  afterEach(() => {
    for (const name of ['vm_portal_doctor', 'vm_portal_admin'])
      document.cookie = `${name}=; Path=/; Max-Age=0`;
  });

  it('signed out: Sign in and Register, no dashboard anywhere (closed or open menu)', () => {
    const { text, dashboards, openMenu } = render(false);
    expect(text()).toContain('Sign in');
    expect(text()).toContain('Register');
    expect(dashboards()).toHaveLength(0);
    openMenu();
    expect(dashboards()).toHaveLength(0);
    expect(text().match(/Sign in/g)).toHaveLength(2);
  });

  it('a signed-in patient: Go to Dashboard (desktop, mobile icon, and in the menu), opening in-app', () => {
    const { text, dashboards, openMenu } = render(true);
    expect(text()).not.toContain('Sign in');
    // Desktop button + the mobile bar's icon button.
    expect(dashboards().map((a) => a.getAttribute('href'))).toEqual([
      '/dashboard',
      '/dashboard',
    ]);
    expect(dashboards()[1].getAttribute('title')).toBe('Go to Dashboard');
    openMenu();
    expect(dashboards()).toHaveLength(3);

    const nav = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    dashboards()[2].dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(nav).toHaveBeenCalledWith('/dashboard');
  });

  it('a doctor signed in on this browser: Go to Dashboard links to the doctor portal (named for it)', () => {
    setCookie('vm_portal_doctor', DOCTOR);
    const { text, dashboards } = render(false);
    expect(text()).not.toContain('Sign in');
    expect(dashboards().map((a) => a.getAttribute('href'))).toEqual([
      `${DOCTOR}/`,
      `${DOCTOR}/`,
    ]);
    expect(dashboards()[0].getAttribute('aria-label')).toBe(
      'Go to Dashboard (doctor portal)',
    );
  });

  it('an admin: the back office', () => {
    setCookie('vm_portal_admin', ADMIN);
    const { dashboards } = render(false);
    expect(dashboards()[0].getAttribute('href')).toBe(`${ADMIN}/`);
    expect(dashboards()[0].getAttribute('aria-label')).toBe(
      'Go to Dashboard (admin console)',
    );
  });

  it('a patient session comes first; a hint for a site outside this group is ignored', () => {
    setCookie('vm_portal_doctor', DOCTOR);
    expect(render(true).dashboards()[0].getAttribute('href')).toBe(
      '/dashboard',
    );
    TestBed.resetTestingModule();
    document.cookie = 'vm_portal_doctor=; Path=/; Max-Age=0';
    setCookie('vm_portal_admin', 'https://evil.example.com');
    const { text, dashboards } = render(false);
    expect(dashboards()).toHaveLength(0);
    expect(text()).toContain('Sign in');
  });

  it('follows a portal sign-in / sign-out made elsewhere when the tab is shown again', () => {
    const { fixture, dashboards } = render(false);
    expect(dashboards()).toHaveLength(0);
    setCookie('vm_portal_doctor', DOCTOR);
    document.dispatchEvent(new Event('visibilitychange'));
    fixture.detectChanges();
    expect(dashboards()).toHaveLength(2);
    document.cookie = 'vm_portal_doctor=; Path=/; Max-Age=0';
    window.dispatchEvent(new Event('pageshow'));
    fixture.detectChanges();
    expect(dashboards()).toHaveLength(0);
  });
});
