import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { API_CONFIG, StaffNotificationsApi } from '@supadoc/data-access';
import { provideSupadocIcons } from '@supadoc/ui';
import { of, Subject } from 'rxjs';
import {
  BELL_POLL_MS,
  bellBadge,
  bellLabel,
  NotificationBell,
} from './notification-bell';
import {
  UNREAD_READ_TIMEOUT_MS,
  UnreadNotifications,
} from './unread-notifications';

describe('NotificationBell', () => {
  let fixture: ComponentFixture<NotificationBell>;
  let el: HTMLElement;
  let unreadCount: number;
  let reads: number;
  const authed = signal(true);

  const link = () => el.querySelector<HTMLAnchorElement>('a');
  const badge = () =>
    el.querySelector<HTMLElement>('a span[aria-hidden="true"]');

  function create(count = 0) {
    unreadCount = count;
    fixture = TestBed.createComponent(NotificationBell);
    el = fixture.nativeElement;
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    reads = 0;
    authed.set(true);
    TestBed.configureTestingModule({
      imports: [NotificationBell],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        {
          provide: StaffNotificationsApi,
          useValue: {
            unread: () => {
              reads++;
              return of({
                status: 'success',
                message: 'OK',
                data: { count: unreadCount },
              });
            },
          },
        },
        {
          provide: StaffAuthService,
          useValue: { isAuthenticated: authed.asReadonly() },
        },
      ],
    });
  });

  afterEach(() => {
    fixture?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('names itself and shows no badge with nothing unread', () => {
    create(0);
    expect(reads).toBe(1);
    expect(link()?.getAttribute('aria-label')).toBe('Notifications');
    expect(link()?.getAttribute('href')).toBe('/notifications');
    expect(badge()).toBeNull();
  });

  it('shows the unread count as text, and says it in its accessible name', () => {
    create(3);
    expect(badge()?.textContent?.trim()).toBe('3');
    expect(link()?.getAttribute('aria-label')).toBe('Notifications, 3 unread');
  });

  it('caps the badge at 99+ but names the real count', () => {
    expect(bellBadge(150)).toBe('99+');
    expect(bellBadge(99)).toBe('99');
    expect(bellLabel(150)).toBe('Notifications, 150 unread');
    expect(bellLabel(0)).toBe('Notifications');
  });

  it('polls the count every minute and when the window regains focus', () => {
    create(1);
    expect(reads).toBe(1);
    vi.advanceTimersByTime(BELL_POLL_MS - 1);
    expect(reads).toBe(1);
    vi.advanceTimersByTime(1);
    expect(reads).toBe(2);
    unreadCount = 4;
    window.dispatchEvent(new Event('focus'));
    expect(reads).toBe(3);
    fixture.detectChanges();
    expect(badge()?.textContent?.trim()).toBe('4');
  });

  it('skips its turn while the tab is hidden', () => {
    create(1);
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    try {
      vi.advanceTimersByTime(BELL_POLL_MS * 2);
      expect(reads).toBe(1);
    } finally {
      // Back to the prototype's getter.
      delete (document as { hidden?: boolean }).hidden;
    }
    vi.advanceTimersByTime(BELL_POLL_MS);
    expect(reads).toBe(2);
  });

  /** The bell's own focus listener, as it registered it. */
  function focusListener(add: { mock: { calls: unknown[][] } }): unknown {
    const call = add.mock.calls.find(([type]) => type === 'focus');
    expect(call?.[1]).toBeTypeOf('function');
    return call?.[1];
  }

  // (The count's own read refuses to run signed out, so "no more reads" alone
  // would pass even if the bell kept polling: check the timer and listener.)
  it('stops polling on sign-out: its timer cleared, its focus listener removed', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    create(5);
    const onFocus = focusListener(add);
    expect(vi.getTimerCount()).toBe(1);
    expect(badge()?.textContent?.trim()).toBe('5');
    authed.set(false);
    fixture.detectChanges();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('focus', onFocus);
    vi.advanceTimersByTime(BELL_POLL_MS * 3);
    window.dispatchEvent(new Event('focus'));
    expect(reads).toBe(1);
  });

  it('stops polling when the shell goes away', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    create(1);
    const onFocus = focusListener(add);
    fixture.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('focus', onFocus);
    vi.advanceTimersByTime(BELL_POLL_MS * 2);
    window.dispatchEvent(new Event('focus'));
    expect(reads).toBe(1);
  });
});

describe('UnreadNotifications', () => {
  afterEach(() => vi.useRealTimers());

  it('reads the count as a background poll (X-SD-Passive), so it never extends the idle session', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        {
          provide: StaffAuthService,
          useValue: { isAuthenticated: () => true },
        },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const unread = TestBed.inject(UnreadNotifications);
    unread.refresh();
    const req = http.expectOne('http://api.test/api/me/notifications/unread');
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('X-SD-Passive')).toBe('1');
    req.flush({ status: 'success', message: 'OK', data: { count: 2 } });
    expect(unread.count()).toBe(2);
    http.verify();
  });

  it('gives up a read that never answers, so the next poll still runs', () => {
    vi.useFakeTimers();
    const reads: Subject<{ data: { count: number } }>[] = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: StaffNotificationsApi,
          useValue: {
            unread: () => {
              const s = new Subject<{ data: { count: number } }>();
              reads.push(s);
              return s;
            },
          },
        },
        {
          provide: StaffAuthService,
          useValue: { isAuthenticated: () => true },
        },
      ],
    });
    const unread = TestBed.inject(UnreadNotifications);
    unread.refresh();
    vi.advanceTimersByTime(UNREAD_READ_TIMEOUT_MS - 1);
    unread.refresh(); // still waiting on the first
    expect(reads).toHaveLength(1);
    vi.advanceTimersByTime(1);
    unread.refresh();
    expect(reads).toHaveLength(2);
    expect(reads[0].observed).toBe(false); // the stalled read is cancelled
    reads[1].next({ data: { count: 6 } });
    expect(unread.count()).toBe(6);
    reads[0].next({ data: { count: 9 } }); // far too late: ignored
    expect(unread.count()).toBe(6);
  });
  it('counts down as items are read, and drops a read that predates a local change', () => {
    const reads: Subject<{ data: { count: number } }>[] = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: StaffNotificationsApi,
          useValue: {
            unread: () => {
              const s = new Subject<{ data: { count: number } }>();
              reads.push(s);
              return s;
            },
          },
        },
        {
          provide: StaffAuthService,
          useValue: { isAuthenticated: () => true },
        },
      ],
    });
    const unread = TestBed.inject(UnreadNotifications);
    unread.refresh();
    unread.refresh(); // one read at a time
    expect(reads).toHaveLength(1);
    reads[0].next({ data: { count: 3 } });
    expect(unread.count()).toBe(3);
    unread.markedRead();
    expect(unread.count()).toBe(2);
    unread.refresh();
    unread.markedAllRead();
    reads[1].next({ data: { count: 2 } }); // read before "mark all" landed: ignored
    expect(unread.count()).toBe(0);
    unread.markedRead();
    expect(unread.count()).toBe(0);
  });

  it('forgets the count when the session ends, drops a read still out, and never reads signed out', () => {
    const reads: Subject<{ data: { count: number } }>[] = [];
    const authed = signal(true);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: StaffNotificationsApi,
          useValue: {
            unread: () => {
              const s = new Subject<{ data: { count: number } }>();
              reads.push(s);
              return s;
            },
          },
        },
        {
          provide: StaffAuthService,
          useValue: { isAuthenticated: authed.asReadonly() },
        },
      ],
    });
    const unread = TestBed.inject(UnreadNotifications);
    unread.refresh();
    reads[0].next({ data: { count: 4 } });
    expect(unread.count()).toBe(4);
    unread.refresh();
    authed.set(false);
    TestBed.tick();
    expect(unread.count()).toBe(0);
    reads[1].next({ data: { count: 9 } });
    expect(unread.count()).toBe(0);
    unread.refresh();
    expect(reads).toHaveLength(2);
  });
});
