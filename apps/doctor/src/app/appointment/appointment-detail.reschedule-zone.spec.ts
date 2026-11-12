import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { AvailabilityCalendarStore, DoctorApi, provideSupadocDataAccess } from '@supadoc/data-access';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService } from '@supadoc/viewer';
import { of } from 'rxjs';
import { DoctorClock } from '../doctor-clock';
import { DoctorAppointmentDetail } from './appointment-detail';
import { NoteDraftStore } from './note-draft';

/*
 * The reschedule panel when the doctor's zone settles late (the profile loads
 * after the panel was opened): the calendar is read again on the new clock,
 * and a time already picked or typed is kept as the same moment.
 */

const APPT = {
  id: 'ap-1',
  patient_id: 'p1',
  patient_name: 'Bola Ade',
  specialist: { id: 's1', name: 'Dr Ada Obi' },
  scheduled_at: '2026-11-20T15:00:00Z',
  ends_at: '2026-11-20T15:30:00Z',
  type: 'video',
  type_label: 'Video consultation',
  status: 'confirmed',
  status_label: 'Confirmed',
  phase: 'upcoming',
  amount: '5000',
  created_at: '2026-11-01T10:00:00Z',
  join_url: null,
};

/** Every DoctorApi call answers something harmless. */
function doctorApi(): DoctorApi {
  const known: Record<string, () => unknown> = {
    appointment: () => of({ data: APPT }),
    patient: () => of({ data: { patient: { id: 'p1', name: 'Bola Ade' }, medical: {}, appointments: [] } }),
    listCertificates: () => of({ data: [], meta: {} }),
    documentAccess: () =>
      of({
        data: {
          access: {
            state: 'none',
            scope: null,
            document_count: 0,
            until: null,
            until_label_at: null,
            indefinite: true,
            folder_until_label_at: null,
            folder_indefinite: false,
            next_change_at: null,
            ends_soon: false,
            had_access_before: false,
          },
          documents: [],
          request: { can_request: false, kind: 'access', blocked_reason: null, available_at: null, pending: null, last: null },
          server_time: new Date().toISOString(),
        },
      }),
    presence: () => of({ data: {} }),
    recordingState: () =>
      of({ data: { configured: true, active: false, recording: null, guest_consent: { connected: 0, pending: 0, pending_ids: [] } } }),
    recordingFiles: () => of({ data: { files: [] } }),
  };
  return new Proxy({} as DoctorApi, {
    get: (_t, name: string) => () => (known[name] ? known[name]() : of({ data: [] })),
  });
}

/** The calendar store as far as the page reads it; load and selectDate are recorded. */
function fakeCalendar() {
  const tz = signal('UTC');
  const specialistId = signal<string | null>(null);
  const selectedDate = signal<string | null>(null);
  return {
    tz,
    specialistId,
    selectedDate,
    days: signal([]),
    month: signal('2026-11'),
    slots: signal(null),
    loading: signal(false),
    slotsLoading: signal(false),
    min: signal(null),
    max: signal('2027-11-30'),
    nextAvailable: signal('2026-11-20T09:00:00Z'),
    range: signal({ from: '2026-11-01', to: '2026-11-30' }),
    error: signal(null),
    timeZoneLabel: signal('Times in your zone'),
    weekStartsOn: signal(1),
    setMonth: vi.fn(),
    refresh: vi.fn(),
    jumpToNext: vi.fn(),
    load: vi.fn((id: string, zone: string) => {
      specialistId.set(id);
      tz.set(zone);
      selectedDate.set(null);
    }),
    selectDate: vi.fn((date: string | null) => selectedDate.set(date)),
  };
}

describe("DoctorAppointmentDetail: reschedule when the doctor's zone settles late", () => {
  let fixture: ComponentFixture<DoctorAppointmentDetail>;
  let el: HTMLElement;
  let cal: ReturnType<typeof fakeCalendar>;
  let clock: DoctorClock;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = () => fixture.componentInstance as any;

  async function settle(rounds = 4) {
    for (let i = 0; i < rounds; i++) {
      fixture.detectChanges();
      TestBed.inject(ApplicationRef).tick();
      await new Promise((r) => setTimeout(r));
    }
  }

  beforeEach(async () => {
    cal = fakeCalendar();
    TestBed.configureTestingModule({
      imports: [DoctorAppointmentDetail],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocDataAccess({ baseUrl: 'http://api.test' }),
        { provide: DoctorApi, useValue: doctorApi() },
        {
          provide: DocumentViewerService,
          useValue: { session: signal(null), open: vi.fn(), revoke: vi.fn(), close: vi.fn(), isShowing: () => false },
        },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'ap-1' }) }, queryParamMap: of(convertToParamMap({})) },
        },
        {
          provide: StaffAuthService,
          useValue: {
            isAuthenticated: signal(true),
            displayName: signal('Dr Ada Obi'),
            subject: signal('doc-1'),
            activityKey: 'videomed.doctor.activity',
            clockOffset: () => 0,
          },
        },
        {
          provide: NoteDraftStore,
          useValue: { take: () => null, clear: () => undefined, save: () => true, peek: () => null },
        },
      ],
    });
    // The page provides its own calendar store: swap that one.
    TestBed.overrideComponent(DoctorAppointmentDetail, {
      set: { providers: [{ provide: AvailabilityCalendarStore, useValue: cal }] },
    });
    clock = TestBed.inject(DoctorClock);
    clock.apply({ timezone: 'America/Chicago' });
    fixture = TestBed.createComponent(DoctorAppointmentDetail);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await settle();
    page().toggleReschedule();
    await settle(2);
  });

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    vi.restoreAllMocks();
  });

  it("first reads the calendar on the doctor's clock", () => {
    expect(cal.load).toHaveBeenLastCalledWith('s1', 'America/Chicago', { scope: 'doctor' });
  });

  it('a picked time is kept, and its day reopened on the new clock', async () => {
    // 23:30 in Chicago on the 20th is already the 21st in Lagos.
    page().rescheduleSlot.set('2026-11-21T05:30:00Z');
    clock.apply({ timezone: 'Africa/Lagos' });
    await settle(2);
    expect(cal.load).toHaveBeenLastCalledWith('s1', 'Africa/Lagos', { scope: 'doctor' });
    expect(page().rescheduleSlot()).toBe('2026-11-21T05:30:00Z');
    expect(cal.selectDate).toHaveBeenLastCalledWith('2026-11-21');
  });

  it('a typed time keeps its moment: shown on the new clock, sent as the same instant', async () => {
    page().setRescheduleManual(true);
    page().rescheduleAt.set('2026-11-25T14:00');
    clock.apply({ timezone: 'Africa/Lagos' });
    await settle(2);
    expect(page().rescheduleManual()).toBe(true);
    // 14:00 CST is 20:00 UTC, which is 21:00 WAT.
    expect(page().rescheduleAt()).toBe('2026-11-25T21:00');
    expect(cal.selectDate).not.toHaveBeenCalled();
  });

  it('with nothing picked the calendar is simply read again', async () => {
    clock.apply({ timezone: 'Asia/Tokyo' });
    await settle(2);
    expect(cal.load).toHaveBeenLastCalledWith('s1', 'Asia/Tokyo', { scope: 'doctor' });
    expect(page().rescheduleSlot()).toBeNull();
    expect(page().rescheduleAt()).toBe('');
  });
});
