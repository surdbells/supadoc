import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideSupadocDataAccess } from '@supadoc/data-access';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import {
  LeavingHome,
  leaveForHome,
  PAGE_LOCATION,
} from '../portal/leave-for-home';
import {
  parsePortalHints,
  portalFrom,
  publicHomeUrl,
  withoutPortalFrom,
} from '../portal/portal-links';
import { provideStaffAuth, type StaffAuthConfig } from '../provide-staff-auth';
import { StaffAuthService } from '../staff-auth.service';
import { portalHintCookie, type SiteLocation } from './portal-hint';
import { RELOAD_PAGE } from './session-utils';
import { tokenFor } from './testing';

const site = (origin: string): SiteLocation => {
  const u = new URL(origin);
  return { protocol: u.protocol, hostname: u.hostname, origin: u.origin };
};
const DOCTOR = site('https://doctor.dosthq.com');
const HOME = site('https://patient.dosthq.com');
const LOCAL = site('http://localhost:4361');
const enc = encodeURIComponent;

describe('portal hint — cookie attributes', () => {
  const now = 1_000_000;

  it('on a live site: the portal origin only, shared on the parent domain, Secure, Lax', () => {
    expect(portalHintCookie('doctor', DOCTOR, now + 3_600_000, now)).toBe(
      `vm_portal_doctor=${enc('https://doctor.dosthq.com')}; Path=/; Max-Age=3600; SameSite=Lax; Secure; Domain=dosthq.com`,
    );
  });

  it('never outlives 12 hours, nor the session', () => {
    expect(
      portalHintCookie('admin', DOCTOR, now + 999 * 3_600_000, now),
    ).toContain('Max-Age=43200;');
    expect(portalHintCookie('admin', DOCTOR, null, now)).toContain(
      'Max-Age=43200;',
    );
    // A session already over: an empty value that expires at once.
    expect(portalHintCookie('admin', DOCTOR, now - 5, now)).toBe(
      'vm_portal_admin=; Path=/; Max-Age=0; SameSite=Lax; Secure; Domain=dosthq.com',
    );
  });

  it('on localhost: host-only (shared across ports) and not Secure', () => {
    expect(portalHintCookie('doctor', LOCAL, now + 60_000, now)).toBe(
      `vm_portal_doctor=${enc('http://localhost:4361')}; Path=/; Max-Age=60; SameSite=Lax`,
    );
  });

  it('removing (deadline 0) uses the same Domain and Path, with Max-Age=0', () => {
    expect(portalHintCookie('doctor', DOCTOR, 0, now)).toBe(
      'vm_portal_doctor=; Path=/; Max-Age=0; SameSite=Lax; Secure; Domain=dosthq.com',
    );
    expect(portalHintCookie('admin', LOCAL, 0, now)).toBe(
      'vm_portal_admin=; Path=/; Max-Age=0; SameSite=Lax',
    );
  });

  it('shares on a parent domain only for a 3+ label name (never an IP or a 2-label name)', () => {
    expect(
      portalHintCookie(
        'admin',
        site('https://backoffice.dosthq.com'),
        null,
        now,
      ),
    ).toContain('; Domain=dosthq.com');
    expect(
      portalHintCookie('admin', site('https://dosthq.com'), null, now),
    ).not.toContain('Domain');
    expect(
      portalHintCookie('admin', site('https://10.0.0.12'), null, now),
    ).not.toContain('Domain');
  });
});

describe('portal hint — reading (the homepage)', () => {
  const cookie = (name: string, value: string) => `${name}=${enc(value)}`;

  it('accepts a sibling site, and uses only its origin', () => {
    expect(
      parsePortalHints(
        `theme=dark; ${cookie('vm_portal_doctor', 'https://doctor.dosthq.com')}; ${cookie('vm_portal_admin', 'https://backoffice.dosthq.com/x?y=1#z')}`,
        HOME,
      ),
    ).toEqual({
      doctor: 'https://doctor.dosthq.com/',
      admin: 'https://backoffice.dosthq.com/',
    });
  });

  it.each([
    ['another domain', 'https://doctor.evil.com'],
    ['a look-alike domain', 'https://doctor.notdosthq.com'],
    // Only the doctor portal's own host: no other sibling (the API, say) can steer it.
    ['another sibling of this site', 'https://api.dosthq.com'],
    ['the other portal', 'https://backoffice.dosthq.com'],
    ['plain http on a live site', 'http://doctor.dosthq.com'],
    ['a script URL', 'javascript:alert(1)'],
    ['a malformed value', '%E0%A4%A'],
    ['not a URL', 'yes'],
  ])('ignores %s', (_why, value) => {
    expect(
      parsePortalHints(
        `vm_portal_doctor=${value.startsWith('%') ? value : enc(value)}`,
        HOME,
      ),
    ).toEqual({});
  });

  it('in dev: localhost portals on any port, nothing else', () => {
    expect(
      parsePortalHints(
        cookie('vm_portal_admin', 'http://localhost:4362'),
        LOCAL,
      ),
    ).toEqual({
      admin: 'http://localhost:4362/',
    });
    expect(
      parsePortalHints(
        cookie('vm_portal_admin', 'https://backoffice.dosthq.com'),
        LOCAL,
      ),
    ).toEqual({});
  });
});

describe('publicHomeUrl (the staff logo)', () => {
  it.each([
    ['https://doctor.dosthq.com', 'https://patient.dosthq.com/'],
    ['https://doctor.betacrest.com', 'https://patient.betacrest.com/'],
    ['https://backoffice.dosthq.com', 'https://patient.dosthq.com/'],
    ['http://localhost:4364', 'http://localhost:4201/'],
    ['http://127.0.0.1:4362', 'http://127.0.0.1:4201/'],
    // A preview / unknown host: the main site, never a guessed stranger's.
    ['https://abc123.supadoc-doctor.pages.dev', 'https://patient.dosthq.com/'],
  ])('%s → %s', (from, to) => {
    expect(publicHomeUrl(site(from))).toBe(to);
  });

  it('names the portal being left, so the homepage leads back there', () => {
    expect(publicHomeUrl(site('https://backoffice.dosthq.com'), 'admin')).toBe(
      'https://patient.dosthq.com/?from=admin',
    );
    expect(publicHomeUrl(site('http://localhost:4364'), 'doctor')).toBe(
      'http://localhost:4201/?from=doctor',
    );
  });
});

describe('portalFrom (the homepage: which portal the visitor came from)', () => {
  const store = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  };

  it('takes ?from=, and keeps it for the tab', () => {
    const st = store();
    expect(portalFrom('?from=admin', st)).toBe('admin');
    expect(portalFrom('', st)).toBe('admin');
    expect(portalFrom('?from=doctor', st)).toBe('doctor');
    expect(portalFrom('?q=1', st)).toBe('doctor');
  });

  it('ignores anything but a portal kind, and survives storage that throws', () => {
    expect(portalFrom('?from=patient', store())).toBeNull();
    expect(portalFrom('?from=__proto__', store())).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(portalFrom('?from=admin', broken)).toBe('admin');
    expect(portalFrom('', broken)).toBeNull();
  });

  it('withoutPortalFrom drops only that parameter', () => {
    expect(withoutPortalFrom('?from=admin')).toBe('');
    expect(withoutPortalFrom('?from=admin&q=heart')).toBe('?q=heart');
    expect(withoutPortalFrom('?q=heart')).toBe('?q=heart');
  });
});

describe('leaveForHome (the staff logo)', () => {
  const loc = () =>
    ({
      ...site('https://doctor.betacrest.com'),
      assign: vi.fn(),
      replace: vi.fn(),
    }) as unknown as Location & {
      assign: ReturnType<typeof vi.fn>;
      replace: ReturnType<typeof vi.fn>;
    };

  it('leaves the page in-app first, then for the homepage as a new history entry (Back returns)', async () => {
    const l = loc();
    const router = {
      url: '/patients/7?tab=notes',
      navigateByUrl: vi.fn().mockResolvedValue(true),
    } as unknown as Router;
    await leaveForHome(router, l, 'doctor', new EventTarget());
    expect(router.navigateByUrl).toHaveBeenCalledWith('/go/home', {
      skipLocationChange: true,
      state: { leftFrom: '/patients/7?tab=notes' },
    });
    expect(l.assign).toHaveBeenCalledWith(
      'https://patient.betacrest.com/?from=doctor',
    );
    expect(l.replace).not.toHaveBeenCalled();
  });

  it('Back restoring this page from the back/forward cache puts the page left back (never a blank portal)', async () => {
    const win = new EventTarget();
    const state = { url: '/patients/7' };
    const nav = vi.fn(async (to: string) => {
      state.url = to;
      return true;
    });
    const router = {
      get url() {
        return state.url;
      },
      navigateByUrl: nav,
    } as unknown as Router;
    await leaveForHome(router, loc(), 'doctor', win);
    expect(router.url).toBe('/go/home');
    nav.mockClear();

    const show = (persisted: boolean) => {
      const e = new Event('pageshow');
      Object.defineProperty(e, 'persisted', { value: persisted });
      win.dispatchEvent(e);
    };
    show(true);
    expect(nav).toHaveBeenCalledWith('/patients/7', { replaceUrl: true });
    // Once only.
    nav.mockClear();
    state.url = '/go/home';
    show(true);
    expect(nav).not.toHaveBeenCalled();
  });

  it('a restore after the user already stayed (no longer on go/home) changes nothing', async () => {
    const win = new EventTarget();
    const nav = vi.fn().mockResolvedValue(true);
    // The navigation to go/home was made, then the user chose "Stay in the portal".
    const router = {
      url: '/dashboard',
      navigateByUrl: nav,
    } as unknown as Router;
    await leaveForHome(router, loc(), 'admin', win);
    nav.mockClear();
    const e = new Event('pageshow');
    Object.defineProperty(e, 'persisted', { value: true });
    win.dispatchEvent(e);
    expect(nav).not.toHaveBeenCalled();
  });

  it('stays when the page is kept (unsaved edits, the user chose to stay)', async () => {
    const l = loc();
    const win = { addEventListener: vi.fn() };
    await leaveForHome(
      {
        url: '/x',
        navigateByUrl: vi.fn().mockResolvedValue(false),
      } as unknown as Router,
      l,
      'doctor',
      win,
    );
    expect(win.addEventListener).not.toHaveBeenCalled();
    expect(l.assign).not.toHaveBeenCalled();
  });

  it('PAGE_LOCATION is the page’s own location by default', () => {
    expect(TestBed.inject(PAGE_LOCATION)).toBe(document.location);
  });
});

describe('StaffAuthService — portal hint', () => {
  const KEY = 'test.doctor.token';
  const NAME = 'vm_portal_doctor';
  const hint = () =>
    document.cookie
      .split('; ')
      .find((c) => c.startsWith(`${NAME}=`))
      ?.slice(NAME.length + 1) ?? null;

  function setup(
    access: string | null,
    config: Partial<StaffAuthConfig> = { portalHint: 'doctor' },
  ) {
    localStorage.clear();
    if (access) localStorage.setItem(KEY, access);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocDataAccess({ baseUrl: 'https://api.test' }),
        provideStaffAuth({
          storageKey: KEY,
          requiredRole: 'doctor',
          ...config,
        }),
        { provide: RELOAD_PAGE, useValue: vi.fn() },
      ],
    });
    return {
      auth: TestBed.inject(StaffAuthService),
      ctl: TestBed.inject(HttpTestingController),
    };
  }

  afterEach(() => {
    document.cookie = `${NAME}=; Path=/; Max-Age=0`;
    localStorage.clear();
  });

  it('a signed-in portal sets it to its own origin (no token, no user details)', () => {
    setup(tokenFor('d1', 900));
    expect(hint()).toBe(enc(location.origin));
  });

  it('signing in sets it; signing out removes it', async () => {
    const { auth, ctl } = setup(null);
    expect(hint()).toBeNull();
    const login = auth.login('grace@example.test', 'pw');
    ctl.expectOne('https://api.test/api/auth/login').flush({
      data: {
        access_token: tokenFor('d1', 900),
        refresh_token: 'R1',
        user: {
          id: 'd1',
          roles: ['doctor'],
          permissions: [],
          first_name: 'G',
          last_name: 'B',
        },
      },
    });
    await login;
    expect(hint()).toBe(enc(location.origin));
    auth.logout();
    expect(hint()).toBeNull();
  });

  it('a stale hint with no session is removed when the app starts', () => {
    document.cookie = `${NAME}=${enc(location.origin)}; Path=/`;
    setup(null);
    expect(hint()).toBeNull();
  });

  it('an app that does not opt in never sets one', () => {
    setup(tokenFor('d1', 900), {});
    expect(hint()).toBeNull();
  });
});

describe('LeavingHome (the go/home page)', () => {
  it('says the homepage is opening, and offers to stay (back to the page left)', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'go/home', component: LeavingHome },
          { path: '**', children: [] },
        ]),
      ],
    });
    const harness = await RouterTestingHarness.create();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/go/home', {
      skipLocationChange: true,
      state: { leftFrom: '/patients/7?tab=notes' },
    });
    harness.detectChanges();
    const el = harness.routeNativeElement as HTMLElement;
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'Opening the VideoMed home page',
    );
    const stay = el.querySelector('a') as HTMLAnchorElement;
    expect(stay.getAttribute('href')).toBe('/patients/7?tab=notes');
    const nav = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    stay.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(nav).toHaveBeenCalledWith('/patients/7?tab=notes', {
      replaceUrl: true,
    });
  });
});
