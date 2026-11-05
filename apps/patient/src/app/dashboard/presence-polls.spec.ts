import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  API_CONFIG,
  AppointmentsApi,
  CALL_PRESENCE_POLL_MS,
  NotificationsApi,
  PatientApi,
  WalletApi,
} from '@supadoc/data-access';
import { of } from 'rxjs';
import { Appointments } from './appointments';
import { DashboardHome } from './dashboard-home';

/*
 * The pages that poll who is in each appointment's call (`injectCallPresence`)
 * send every read passive (`X-SD-Passive`): a dashboard or list left open
 * never keeps an idle session alive. Only the poll is under test here — the
 * pages are constructed, never rendered.
 */

/** A service whose every method answers an empty page, each call recorded. */
function stub<T>(calls: Record<string, unknown[][]>): T {
  return new Proxy({} as object, {
    get: (_t, name: string) =>
      (...args: unknown[]) => {
        (calls[name] ??= []).push(args);
        return of({
          status: 'success',
          message: 'OK',
          data: [],
          meta: { total: 0, page: 1, per_page: 10, total_pages: 0, unread: 0 },
        });
      },
  }) as T;
}

describe('presence polls are passive', () => {
  let calls: Record<string, unknown[][]>;

  beforeEach(() => {
    calls = {};
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        { provide: AppointmentsApi, useValue: stub<AppointmentsApi>(calls) },
        { provide: PatientApi, useValue: stub<PatientApi>({}) },
        { provide: NotificationsApi, useValue: stub<NotificationsApi>({}) },
        { provide: WalletApi, useValue: stub<WalletApi>({}) },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  const pages: ReadonlyArray<[string, Type<unknown>]> = [
    ['the dashboard', DashboardHome],
    ['my appointments', Appointments],
  ];

  for (const [name, page] of pages) {
    it(`${name}: the first read and every poll pass { passive: true }`, () => {
      const fixture = TestBed.createComponent(page);
      expect(calls['presence']).toEqual([[{ passive: true }]]);
      vi.advanceTimersByTime(2 * CALL_PRESENCE_POLL_MS);
      expect(calls['presence']).toEqual([[{ passive: true }], [{ passive: true }], [{ passive: true }]]);
      fixture.destroy();
    });
  }
});
