/// <reference types="node" />
// Node types for this spec only: it reads the API's PHP permission list from disk.
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StaffAuthService } from '@supadoc/auth';
import { API_CONFIG } from '@supadoc/data-access';
import type { StaffUserDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { AdminStaff, STAFF_PERMISSIONS } from './staff';

/** The PHP list the API filters every grant through (cleanPermissions). */
const MANAGES_STAFF = 'apps/api/src/Action/Admin/ManagesStaff.php';

/** A workspace file's text. The unit-test builder runs bundled specs, so look upward from the working directory. */
function workspaceFile(path: string): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, path);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${path} not found above ${process.cwd()}`);
    dir = parent;
  }
}

/** A plain PHP string literal: single-quoted, or double-quoted with no escapes or interpolation. */
const PHP_STRING = /'([^'\\]+)'|"([^"\\$]+)"/g;

/**
 * The entries of a PHP `const PERMISSIONS = [...]`, comments left out, in order.
 * Throws on anything but plain string literals (a spread, a constant, a key), so an
 * entry this parse can't read fails the check instead of silently dropping out of it.
 */
function parsePermissions(php: string, file: string): string[] {
  const list = /const\s+PERMISSIONS\s*=\s*\[([\s\S]*?)\];/.exec(php);
  if (!list) throw new Error(`No PERMISSIONS list in ${file}`);
  const code = list[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?:\/\/|#).*$/gm, '');
  const leftover = code.replace(PHP_STRING, '').replace(/[\s,]/g, '');
  if (leftover !== '') throw new Error(`${file}: PERMISSIONS holds something other than plain strings: ${leftover}`);
  return [...code.matchAll(PHP_STRING)].map((m) => m[1] ?? m[2]);
}

/** `ManagesStaff::PERMISSIONS`, in order. */
const apiPermissions = (): string[] => parsePermissions(workspaceFile(MANAGES_STAFF), MANAGES_STAFF);

describe('the ManagesStaff::PERMISSIONS parser', () => {
  const php = (body: string) => `<?php\ntrait T {\n    private const PERMISSIONS = [\n${body}\n    ];\n}\n`;

  it('reads single- and double-quoted entries in order and skips comments', () => {
    const body = ["'a.view',", '// a note', '"b.manage", # another', "/* block */ 'c.manage'"].join('\n');
    expect(parsePermissions(php(body), 'x.php')).toEqual(['a.view', 'b.manage', 'c.manage']);
  });

  it.each([
    ['a spread', "'a.view',\n...self::EXTRA,"],
    ['a class constant', "'a.view',\nself::REPORTS_VIEW,"],
    ['a key', "'a' => 'a.view',"],
    ['an interpolated string', "'a.view',\n\"{$x}.manage\","],
  ])('fails on %s rather than dropping it', (_, body) => {
    expect(() => parsePermissions(php(body), 'x.php')).toThrow(/other than plain strings/);
  });

  it('fails when there is no list', () => {
    expect(() => parsePermissions('<?php\n', 'x.php')).toThrow(/No PERMISSIONS list/);
  });
});

describe('STAFF_PERMISSIONS', () => {
  it('offers every permission the API accepts, in the API order, and nothing else', () => {
    const api = apiPermissions();
    // Guard the parser itself: a broken regex would compare two empty lists.
    expect(api).toContain('staff.manage');
    expect(api.length).toBeGreaterThanOrEqual(10);
    expect(STAFF_PERMISSIONS.map((p) => p.value)).toEqual(api);
  });

  it('offers payouts and support with labels and descriptions that say what they open', () => {
    expect(STAFF_PERMISSIONS).toContainEqual({
      value: 'payouts.manage',
      label: 'Manage payouts',
      description: 'Approve, reject and mark payouts paid; shows full bank details and revenue.',
    });
    expect(STAFF_PERMISSIONS).toContainEqual({
      value: 'support.manage',
      label: 'Manage support tickets',
      description: 'Read and reply to patient tickets, and resolve or close them.',
    });
  });

  it('gives every option a distinct label and a one-line description', () => {
    const values = STAFF_PERMISSIONS.map((p) => p.value);
    const labels = STAFF_PERMISSIONS.map((p) => p.label);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(labels).size).toBe(labels.length);
    for (const p of STAFF_PERMISSIONS) {
      expect(p.label.trim(), p.value).not.toBe('');
      expect(p.description.trim(), p.value).not.toBe('');
      expect(p.description, p.value).not.toMatch(/\n/);
      expect(p.description.length, p.value).toBeLessThanOrEqual(80);
      expect(p.description, p.value).toMatch(/\.$/);
    }
  });
});

describe('AdminStaff — permissions', () => {
  const BASE = 'http://api.test';
  let fixture: ComponentFixture<AdminStaff>;
  let el: HTMLElement;
  let http: HttpTestingController;

  const ok = <T>(data: T) => ({ status: 'success', message: 'OK', data });
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const user = (overrides: Partial<StaffUserDto> = {}): StaffUserDto => ({
    id: 'u1',
    email: 'ada@videomed.test',
    first_name: 'Ada',
    last_name: 'Obi',
    roles: ['staff'],
    permissions: [],
    active: true,
    specialist_id: null,
    created_at: '2026-11-01T09:00:00Z',
    ...overrides,
  });
  const flushLists = (users: StaffUserDto[]) => {
    for (const req of http.match((r) => r.method === 'GET' && r.url === `${BASE}/api/staff`)) {
      if (!req.cancelled) req.flush(ok(users));
    }
    for (const req of http.match((r) => r.method === 'GET' && r.url === `${BASE}/api/specialists`)) {
      if (!req.cancelled) req.flush(ok([]));
    }
  };
  const button = (text: string) => {
    const found = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.replace(/\s+/g, ' ').trim() === text,
    );
    if (!found) throw new Error(`No button "${text}"`);
    return found;
  };
  /** The permission checkbox named `label`, found the way assistive tech names it. */
  const checkbox = (label: string): HTMLInputElement => {
    const found = Array.from(el.querySelectorAll<HTMLInputElement>('input[type="checkbox"][aria-labelledby]')).find(
      (input) => document.getElementById(input.getAttribute('aria-labelledby') ?? '')?.textContent?.trim() === label,
    );
    if (!found) throw new Error(`No permission checkbox "${label}"`);
    return found;
  };
  const hint = (input: HTMLInputElement) =>
    document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent?.trim();
  const submit = async () => {
    el.querySelector<HTMLFormElement>('#bo-staff-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
  };

  const setup = async (users: StaffUserDto[] = []) => {
    await TestBed.configureTestingModule({
      imports: [AdminStaff],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
        { provide: StaffAuthService, useValue: { hasRole: () => false, hasPermission: () => true, isAuthenticated: () => true } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AdminStaff);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    http = TestBed.inject(HttpTestingController);
    await render();
    flushLists(users);
    await render();
  };

  afterEach(() => {
    http.verify();
    el.remove();
  });

  it('lists every permission in the editor, payouts and support included, each with its description', async () => {
    await setup();
    button('New staff').click();
    await render();
    for (const p of STAFF_PERMISSIONS) {
      const input = checkbox(p.label);
      expect(input.checked, p.value).toBe(false);
      expect(hint(input), p.value).toBe(p.description);
    }
    expect(hint(checkbox('Manage payouts'))).toBe('Approve, reject and mark payouts paid; shows full bank details and revenue.');
    expect(hint(checkbox('Manage support tickets'))).toBe('Read and reply to patient tickets, and resolve or close them.');
  });

  it('grants payouts.manage and support.manage on a new account', async () => {
    await setup();
    button('New staff').click();
    await render();
    const field = (selector: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(selector);
      if (!input) throw new Error(`No ${selector}`);
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    field('input[type="email"]', 'sam@videomed.test');
    field('input[placeholder="At least 8 characters"]', 'temporary-pass');
    checkbox('Manage payouts').click();
    checkbox('Manage support tickets').click();
    await render();
    await submit();
    const req = http.expectOne((r) => r.method === 'POST' && r.url === `${BASE}/api/staff`);
    expect(req.request.body.permissions).toEqual(['payouts.manage', 'support.manage']);
    req.flush(ok(user({ email: 'sam@videomed.test', permissions: ['payouts.manage', 'support.manage'] })));
    await render();
    flushLists([]);
  });

  it('shows payouts and support as held when editing, and can take one away', async () => {
    const held = user({ permissions: ['payouts.manage', 'support.manage', 'monitoring.view'] });
    await setup([held]);
    el.querySelector<HTMLButtonElement>('button[aria-label^="Edit Ada Obi"]')?.click();
    await render();
    expect(checkbox('Manage payouts').checked).toBe(true);
    expect(checkbox('Manage support tickets').checked).toBe(true);
    expect(checkbox('View monitoring').checked).toBe(true);
    expect(checkbox('Manage staff').checked).toBe(false);
    checkbox('Manage support tickets').click();
    await render();
    await submit();
    const req = http.expectOne((r) => r.method === 'PATCH' && r.url === `${BASE}/api/staff/u1`);
    expect(req.request.body.permissions).toEqual(['payouts.manage', 'monitoring.view']);
    req.flush(ok({ ...held, permissions: ['payouts.manage', 'monitoring.view'] }));
    await render();
    flushLists([]);
  });
});
