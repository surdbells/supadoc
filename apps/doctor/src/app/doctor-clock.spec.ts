import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { StaffAuthService } from '@supadoc/auth';
import { CLINIC_TIME_ZONE, DoctorApi, viewerTimeZone } from '@supadoc/data-access';
import type { DoctorProfileDto } from '@supadoc/models';
import { Observable, of, Subject, throwError } from 'rxjs';
import { DoctorClock } from './doctor-clock';

function profile(over: Partial<DoctorProfileDto> = {}): DoctorProfileDto {
  return { id: 'd1', name: 'Dr Ada Obi', specialty: 'Cardiology', ...over } as DoctorProfileDto;
}

describe('DoctorClock', () => {
  let answer: () => Observable<{ data: DoctorProfileDto }>;
  let calls: number;
  const signedIn = signal(true);
  const subject = signal<string | null>('doc-1');

  function setup(): DoctorClock {
    calls = 0;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DoctorApi,
          useValue: {
            getProfile: () => {
              calls++;
              return answer();
            },
          },
        },
        { provide: StaffAuthService, useValue: { isAuthenticated: signedIn, subject } },
      ],
    });
    return TestBed.inject(DoctorClock);
  }

  beforeEach(() => {
    signedIn.set(true);
    subject.set('doc-1');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T15:00:00Z')); // Wed 4 Nov 2026, 9:00 AM CST
  });
  afterEach(() => vi.useRealTimers());

  it('is loading (device zone, display only) until the profile answers, then ready on its zone', async () => {
    const pending = new Subject<{ data: DoctorProfileDto }>();
    answer = () => pending;
    const clock = setup();
    const loaded = clock.ensureLoaded();
    expect(clock.status()).toBe('loading');
    expect(clock.zone()).toBe(viewerTimeZone());
    expect(clock.profileZone()).toBeNull();

    pending.next({ data: profile({ timezone: 'America/Chicago', timezone_source: 'manual' }) });
    pending.complete();
    await loaded;
    expect(clock.status()).toBe('ready');
    expect(clock.zone()).toBe('America/Chicago');
    expect(clock.profileZone()).toBe('America/Chicago');
    expect(clock.source()).toBe('manual');
    expect(clock.abbr()).toBe('CST');
    expect(clock.supported()).toBe(true);
    expect(clock.when('2026-11-04T15:00:00Z')).toBe('Wed 4 Nov, 9:00 AM CST');
    expect(clock.timeTz('2026-11-04T15:00:00Z')).toBe('9:00 AM CST');
    expect(clock.today()).toBe('2026-11-04');
    expect(clock.nowHm()).toBe('09:00');
  });

  it('uses the clinic zone for a loaded profile without `timezone` (an older API)', async () => {
    answer = () => of({ data: profile() });
    const clock = setup();
    await clock.ensureLoaded();
    expect(clock.status()).toBe('ready');
    expect(clock.zone()).toBe(CLINIC_TIME_ZONE);
    expect(clock.profileZone()).toBeNull();
    expect(clock.supported()).toBe(false);
    expect(clock.abbr()).toBe('WAT');
  });

  it('fails without a zone to write with, and retry() loads it', async () => {
    answer = () => throwError(() => new Error('offline'));
    const clock = setup();
    await clock.ensureLoaded();
    expect(clock.status()).toBe('failed');
    expect(clock.profileZone()).toBeNull();
    expect(clock.zone()).toBe(viewerTimeZone());

    answer = () => of({ data: profile({ timezone: 'Africa/Lagos', timezone_source: null }) });
    await clock.retry();
    expect(clock.status()).toBe('ready');
    expect(clock.zone()).toBe('Africa/Lagos');
    expect(clock.source()).toBeNull();
  });

  it('loads once per signed-in doctor, and again for another one', async () => {
    answer = () => of({ data: profile({ timezone: 'Africa/Lagos', timezone_source: 'auto' }) });
    const clock = setup();
    await clock.ensureLoaded();
    await clock.ensureLoaded();
    expect(calls).toBe(1);
    subject.set('doc-2');
    await clock.ensureLoaded();
    expect(calls).toBe(2);
  });

  it('fetches nothing without a portal session', async () => {
    answer = () => of({ data: profile({ timezone: 'Africa/Lagos' }) });
    signedIn.set(false);
    const clock = setup();
    await clock.ensureLoaded();
    expect(calls).toBe(0);
    expect(clock.status()).toBe('failed');
  });

  it('apply() takes a reported zone and keeps the source when the answer has none', async () => {
    answer = () => of({ data: profile({ timezone: 'Africa/Lagos', timezone_source: 'auto' }) });
    const clock = setup();
    await clock.ensureLoaded();
    clock.apply({ timezone: 'America/Chicago' });
    expect(clock.zone()).toBe('America/Chicago');
    expect(clock.source()).toBe('auto');
    clock.apply({ timezone: 'Europe/London', timezone_source: 'manual' });
    expect(clock.source()).toBe('manual');
    expect(clock.profile()?.timezone).toBe('Europe/London');
    clock.apply({ timezone: 'Not/AZone' });
    expect(clock.zone()).toBe('Europe/London');
  });

  it("gives the patient's time only when the offsets differ", async () => {
    answer = () => of({ data: profile({ timezone: 'America/Chicago', timezone_source: 'manual' }) });
    const clock = setup();
    await clock.ensureLoaded();
    expect(clock.patientTime('2026-11-04T15:00:00Z', 'Africa/Lagos')).toBe('4:00 PM WAT');
    expect(clock.patientTime('2026-11-05T03:00:00Z', 'Africa/Lagos')).toBe('Thu 4:00 AM WAT');
    expect(clock.patientTime('2026-11-04T15:00:00Z', 'America/Winnipeg')).toBeNull();
    expect(clock.patientTime('2026-11-04T15:00:00Z', null)).toBeNull();
  });
});
