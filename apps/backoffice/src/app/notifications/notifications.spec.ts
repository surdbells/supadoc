import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { API_CONFIG } from '@supadoc/data-access';
import type { StaffNotificationDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { LAB_SECTION_ID } from './notification-target';
import { AdminNotifications, NOTIFICATIONS_PER_PAGE } from './notifications';
import { UnreadNotifications } from './unread-notifications';

const BASE = 'http://api.test';
const LIST = `${BASE}/api/me/notifications`;
const UNREAD = `${BASE}/api/me/notifications/unread`;
const READ_ALL = `${BASE}/api/me/notifications/read-all`;

@Component({ template: '' })
class Blank {}

const note = (
  over: Partial<StaffNotificationDto> = {},
): StaffNotificationDto => ({
  id: 'n-1',
  type: 'onboarding',
  title: 'Doctor ready for review',
  body: 'Ada Obi submitted their profile for review.',
  link: '/specialists/s-1',
  read: false,
  created_at: '2026-11-04T09:00:00+00:00',
  ...over,
});

const page = (data: StaffNotificationDto[], p = 1, totalPages = 1) => ({
  status: 'success',
  message: 'OK',
  data,
  meta: {
    total: data.length,
    page: p,
    per_page: NOTIFICATIONS_PER_PAGE,
    total_pages: totalPages,
  },
});

describe('AdminNotifications', () => {
  let fixture: ComponentFixture<AdminNotifications>;
  let el: HTMLElement;
  let http: HttpTestingController;
  let permissions: string[];

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const lists = () => http.match((r) => r.method === 'GET' && r.url === LIST);
  const unreads = () =>
    http.match((r) => r.method === 'GET' && r.url === UNREAD);
  const button = (text: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.replace(/\s+/g, ' ').trim().startsWith(text),
    );
  const items = () => Array.from(el.querySelectorAll<HTMLLIElement>('ul > li'));
  const text = () => el.textContent?.replace(/\s+/g, ' ') ?? '';

  /** Opens the page, answers the first list read with `data` and the badge read with `unread`. */
  async function open(
    data: StaffNotificationDto[],
    unread = data.filter((n) => !n.read).length,
    totalPages = 1,
  ) {
    fixture = TestBed.createComponent(AdminNotifications);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
    const [first] = lists();
    expect(first.request.params.get('page')).toBe('1');
    expect(first.request.params.get('per_page')).toBe(
      String(NOTIFICATIONS_PER_PAGE),
    );
    first.flush(page(data, 1, totalPages));
    unreads().forEach((r) => {
      // The badge's read never counts as activity (it must not keep a session alive).
      expect(r.request.headers.get('X-SD-Passive')).toBe('1');
      r.flush({ status: 'success', message: 'OK', data: { count: unread } });
    });
    await render();
  }

  beforeEach(async () => {
    permissions = ['monitoring.view', 'specialists.manage'];
    await TestBed.configureTestingModule({
      imports: [AdminNotifications],
      providers: [
        provideRouter([
          { path: '', component: Blank },
          { path: 'patients/:id', component: Blank },
          { path: 'specialists/:id', component: Blank },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
        {
          provide: StaffAuthService,
          useValue: {
            isAuthenticated: () => true,
            hasPermission: (p: string) => permissions.includes(p),
          },
        },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    el?.remove();
  });

  it('lists notifications newest first (as the API sends them), with time and read state', async () => {
    await open([
      note(),
      note({
        id: 'n-2',
        type: 'application',
        title: 'Application withdrawn: Tunde Bello',
        body: null,
        link: '/applications/a-2',
        read: true,
        created_at: '2026-11-03T08:00:00+00:00',
      }),
    ]);
    const [first, second] = items();
    expect(items()).toHaveLength(2);
    expect(first.textContent).toContain('Doctor ready for review');
    expect(first.textContent).toContain(
      'Ada Obi submitted their profile for review.',
    );
    expect(first.textContent).toContain('New');
    expect(first.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-11-04T09:00:00+00:00',
    );
    expect(first.querySelector('time')?.textContent).toMatch(
      /^\w{3} \d{1,2} Nov 2026, \d{1,2}:\d{2} [AP]M \S+$/,
    );
    expect(second.textContent).toContain('Application withdrawn: Tunde Bello');
    expect(second.textContent).not.toContain('New');
    expect(text()).toContain('1 unread');
    expect(button('Mark all as read')).toBeTruthy();
  });

  it('says so when there is nothing yet', async () => {
    await open([]);
    expect(text()).toContain("You're all caught up");
    expect(button('Mark all as read')).toBeUndefined();
  });

  it('shows a load error with a retry', async () => {
    fixture = TestBed.createComponent(AdminNotifications);
    el = fixture.nativeElement;
    await render();
    lists()[0].flush(
      { status: 'error', message: 'Down' },
      { status: 500, statusText: 'Server Error' },
    );
    unreads()[0].flush({
      status: 'success',
      message: 'OK',
      data: { count: 0 },
    });
    await render();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load notifications",
    );
    button('Try again')?.click();
    await render();
    lists()[0].flush(page([note()]));
    await render();
    expect(items()).toHaveLength(1);
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('marks one read from its button when it has no link', async () => {
    await open([
      note({
        id: 'n-9',
        type: 'lab',
        title: 'Lab result not reviewed',
        body: 'Lab request LR-1 has a result waiting more than 7 days.',
        link: null,
      }),
    ]);
    const unread = TestBed.inject(UnreadNotifications);
    expect(unread.count()).toBe(1);
    expect(items()[0].querySelector('a')).toBeNull();
    button('Mark as read')?.click();
    await render();
    const req: TestRequest = http.expectOne(`${LIST}/n-9/read`);
    expect(req.request.method).toBe('POST');
    // Not claimed before the API agrees.
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('');
    req.flush({
      status: 'success',
      message: 'OK',
      data: note({ id: 'n-9', read: true }),
    });
    await render();
    expect(items()[0].textContent).not.toContain('New');
    expect(button('Mark as read')).toBeUndefined();
    expect(unread.count()).toBe(0);
    expect(document.activeElement?.id).toBe('bo-note-n-9');
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'Marked as read.',
    );
  });

  it('announces each read, even the same words twice in a row', async () => {
    await open([
      note({ id: 'n-1', link: null }),
      note({ id: 'n-2', link: null }),
    ]);
    const status = () => el.querySelector('[role="status"]')?.textContent;
    const markAndConfirm = async (id: string) => {
      button('Mark as read')?.click();
      await render();
      http.expectOne(`${LIST}/${id}/read`).flush({
        status: 'success',
        message: 'OK',
        data: note({ id, read: true }),
      });
      await render();
    };
    await markAndConfirm('n-1');
    const first = status();
    expect(first).toContain('Marked as read.');
    await markAndConfirm('n-2');
    // A live region only speaks when its text changes.
    expect(status()).toContain('Marked as read.');
    expect(status()).not.toBe(first);
  });

  it('puts a read back when the API refuses it, and says so', async () => {
    await open([note({ link: null })]);
    const unread = TestBed.inject(UnreadNotifications);
    expect(unread.count()).toBe(1);
    button('Mark as read')?.click();
    await render();
    expect(unread.count()).toBe(0);
    http
      .expectOne(`${LIST}/n-1/read`)
      .flush({ status: 'error' }, { status: 409, statusText: 'Conflict' });
    await render();
    expect(items()[0].textContent).toContain('New');
    expect(button('Mark as read')).toBeTruthy();
    const alert = items()[0].querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      'Could not mark this notification as read. Please try again.',
    );
    expect(el.querySelector('[role="status"]')?.textContent).not.toContain(
      'Marked as read.',
    );
    // The badge is put right by a fresh read of the server's count.
    unreads()[0].flush({
      status: 'success',
      message: 'OK',
      data: { count: 1 },
    });
    expect(unread.count()).toBe(1);
    // Trying again clears the message.
    button('Mark as read')?.click();
    await render();
    expect(items()[0].querySelector('[role="alert"]')).toBeNull();
    http.expectOne(`${LIST}/n-1/read`).flush({
      status: 'success',
      message: 'OK',
      data: note({ read: true }),
    });
  });

  it('marks all read', async () => {
    await open([note(), note({ id: 'n-2', link: null })], 5);
    const unread = TestBed.inject(UnreadNotifications);
    button('Mark all as read')?.click();
    await render();
    const req = http.expectOne(READ_ALL);
    expect(req.request.method).toBe('POST');
    req.flush({ status: 'success', message: 'OK', data: { read: true } });
    await render();
    expect(text()).not.toContain('New');
    expect(button('Mark all as read')).toBeUndefined();
    expect(unread.count()).toBe(0);
    expect(document.activeElement?.tagName).toBe('H1');
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'All notifications marked as read.',
    );
  });

  it('says so when marking all read fails, and keeps them unread', async () => {
    await open([note()]);
    button('Mark all as read')?.click();
    await render();
    http
      .expectOne(READ_ALL)
      .flush(
        { status: 'error', message: 'Try later' },
        { status: 503, statusText: 'Unavailable' },
      );
    await render();
    expect(el.querySelector('[role="alert"]')).toBeTruthy();
    expect(items()[0].textContent).toContain('New');
    expect(button('Mark all as read')).toBeTruthy();
  });

  it('links a lab escalation to the patient page, Lab requests section, and marks it read on open', async () => {
    await open([
      note({
        id: 'n-3',
        type: 'lab',
        title: 'Lab result not reviewed',
        body: null,
        link: '/patients/p-1',
      }),
    ]);
    const a = items()[0].querySelector('a');
    expect(a?.getAttribute('href')).toBe(`/patients/p-1#${LAB_SECTION_ID}`);
    expect(a?.textContent?.trim()).toBe('Lab result not reviewed');
    a?.click();
    await render();
    http.expectOne(`${LIST}/n-3/read`).flush({
      status: 'success',
      message: 'OK',
      data: note({ id: 'n-3', read: true }),
    });
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe(`/patients/p-1#${LAB_SECTION_ID}`);
  });

  it('shows no link where the role cannot open the page, or the path is not a console page', async () => {
    permissions = ['labs.manage'];
    await open([
      note({ id: 'n-4', type: 'lab', link: '/patients/p-1' }),
      note({ id: 'n-5', type: 'payout', link: '/payouts', read: true }),
    ]);
    expect(el.querySelectorAll('ul a')).toHaveLength(0);
    // The unread one can still be marked read.
    expect(button('Mark as read')).toBeTruthy();
  });

  it('loads more pages and never lists one twice', async () => {
    await open([note({ id: 'n-1' }), note({ id: 'n-2', read: true })], 1, 2);
    button('Load more')?.click();
    await render();
    const [next] = lists();
    expect(next.request.params.get('page')).toBe('2');
    next.flush(
      page(
        [note({ id: 'n-2', read: true }), note({ id: 'n-3', read: true })],
        2,
        2,
      ),
    );
    await render();
    expect(items()).toHaveLength(3);
    expect(button('Load more')).toBeUndefined();
  });
});
