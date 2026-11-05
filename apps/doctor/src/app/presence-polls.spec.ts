import { signal, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { CALL_PRESENCE_POLL_MS, DoctorApi, StaffNotificationsApi } from '@supadoc/data-access';
import { of } from 'rxjs';
import { DoctorDashboard } from './dashboard/dashboard';
import { DoctorSchedule } from './schedule/schedule';
import { DoctorStandingStore } from './standing/doctor-standing.store';

/*
 * The pages that poll who is in each consultation's call (`injectCallPresence`)
 * send every read passive (`X-SD-Passive`): a schedule or dashboard left open
 * never keeps an idle session alive. Only the poll is under test here — the
 * pages are constructed, never rendered.
 */

/** A service whose every method answers `{ data: [] }`, each call recorded. */
function stub<T>(calls: Record<string, unknown[][]>): T {
  return new Proxy({} as object, {
    get: (_t, name: string) =>
      (...args: unknown[]) => {
        (calls[name] ??= []).push(args);
        return of({ status: 'success', message: 'OK', data: [], meta: { unread: 0 } });
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
        { provide: DoctorApi, useValue: stub<DoctorApi>(calls) },
        { provide: StaffNotificationsApi, useValue: stub<StaffNotificationsApi>({}) },
        {
          provide: StaffAuthService,
          useValue: { isAuthenticated: signal(true), subject: signal('doc-1'), displayName: signal('Dr Ada Obi'), clockOffset: () => 0 },
        },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  const pages: ReadonlyArray<[string, Type<unknown>]> = [
    ['the dashboard', DoctorDashboard],
    ['the schedule', DoctorSchedule],
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

  it('the dashboard: no presence reads at all while clinical work is closed to the doctor', () => {
    TestBed.overrideProvider(DoctorStandingStore, {
      useValue: {
        blocked: signal(true),
        onboarding: signal(null),
        code: signal('practitioner_terms_required'),
        load: () => Promise.resolve(null),
      },
    });
    const fixture = TestBed.createComponent(DoctorDashboard);
    vi.advanceTimersByTime(2 * CALL_PRESENCE_POLL_MS);
    expect(calls['presence']).toBeUndefined();
    fixture.destroy();
  });
});
