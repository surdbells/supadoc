import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  convertToParamMap,
  provideRouter,
} from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import {
  AvailabilityCalendarStore,
  DoctorApi,
  provideSupadocDataAccess,
} from '@supadoc/data-access';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService } from '@supadoc/viewer';
import { of } from 'rxjs';
import { DoctorAppointmentDetail } from './appointment-detail';
import { NoteDraftStore } from './note-draft';

/*
 * The appointment page's primary tabs (tailwind/pills.css): WAI-ARIA tabs whose
 * pill look follows aria-selected. Before, they exposed no state at all.
 */

const APPT = {
  id: 'ap-1',
  patient_id: 'p1',
  patient_name: 'Bola Ade',
  specialist: { id: 's1', name: 'Dr Ada Obi' },
  scheduled_at: '2026-11-03T15:00:00Z',
  ends_at: '2026-11-03T15:30:00Z',
  type: 'video',
  type_label: 'Video consultation',
  status: 'completed',
  status_label: 'Completed',
  phase: 'past',
  amount: '5000',
  created_at: '2026-11-01T10:00:00Z',
  join_url: null,
};

describe('DoctorAppointmentDetail primary tabs', () => {
  let fixture: ComponentFixture<DoctorAppointmentDetail>;
  let el: HTMLElement;

  /** Every DoctorApi call answers something harmless. */
  function doctorApi(): DoctorApi {
    const known: Record<string, () => unknown> = {
      appointment: () => of({ data: APPT }),
      patient: () =>
        of({
          data: {
            patient: { id: 'p1', name: 'Bola Ade' },
            medical: {},
            appointments: [],
          },
        }),
      listCertificates: () => of({ data: [], meta: {} }),
      listReferrals: () => of({ data: [] }),
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
            request: {
              can_request: false,
              kind: 'access',
              blocked_reason: null,
              available_at: null,
              pending: null,
              last: null,
            },
            server_time: new Date().toISOString(),
          },
        }),
      presence: () => of({ data: {} }),
      recordingState: () =>
        of({
          data: {
            configured: true,
            active: false,
            recording: null,
            guest_consent: { connected: 0, pending: 0, pending_ids: [] },
          },
        }),
      recordingFiles: () => of({ data: { files: [] } }),
      getProfile: () =>
        of({
          data: {
            id: 'd1',
            name: 'Dr Ada Obi',
            timezone: 'UTC',
            timezone_source: 'manual',
          },
        }),
    };
    const fns: Record<string, ReturnType<typeof vi.fn>> = {};
    return new Proxy({} as DoctorApi, {
      get: (_t, name: string) =>
        (fns[name] ??= vi.fn(() =>
          known[name] ? known[name]() : of({ data: [] }),
        )),
    });
  }

  /** The page polls and ticks (intervals), so it is never "stable": render a few rounds instead. */
  async function settle(rounds = 4) {
    for (let i = 0; i < rounds; i++) {
      fixture.detectChanges();
      TestBed.inject(ApplicationRef).tick();
      await new Promise((r) => setTimeout(r));
    }
  }

  beforeEach(async () => {
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
          useValue: {
            session: signal(null),
            open: vi.fn(),
            revoke: vi.fn(),
            close: vi.fn(),
            isShowing: () => false,
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ id: 'ap-1' }) },
            queryParamMap: of(convertToParamMap({})),
          },
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
          provide: AvailabilityCalendarStore,
          useValue: { load: () => undefined },
        },
        {
          provide: NoteDraftStore,
          useValue: {
            take: () => null,
            clear: () => undefined,
            save: () => true,
            peek: () => null,
          },
        },
      ],
    });
    fixture = TestBed.createComponent(DoctorAppointmentDetail);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await settle();
  });

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    vi.restoreAllMocks();
  });

  const tablist = () =>
    el.querySelector(
      '[role="tablist"][aria-label="Appointment record"]',
    ) as HTMLElement;
  const tabs = () => [
    ...tablist().querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ];
  const selected = () => tabs().map((t) => t.getAttribute('aria-selected'));
  const key = async (target: HTMLElement, k: string) => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
    );
    await settle(2);
  };

  it('is a tablist of M pills; one tab is selected and is the only one in the tab order', () => {
    expect(tablist().classList).toContain('sd-track');
    expect(tabs().map((t) => t.textContent?.trim())).toEqual([
      'Overview',
      'Medical History',
      'Documents',
      'Past Visits',
      'Clinical tools',
    ]);
    for (const t of tabs()) {
      expect([...t.classList]).toEqual(
        expect.arrayContaining(['sd-pill', 'sd-pill-m', 'sd-seg']),
      );
      expect(t.className).not.toMatch(/\bbg-frost\b|\btext-cerulean-dark\b/);
    }
    expect(selected()).toEqual(['true', 'false', 'false', 'false', 'false']);
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1]);
  });

  it('a click moves aria-selected and the tab stop', async () => {
    tabs()[1].click();
    await settle(2);
    expect(selected()).toEqual(['false', 'true', 'false', 'false', 'false']);
    expect(tabs()[1].tabIndex).toBe(0);
  });

  it('the selected tab controls the one tab panel, which it labels', async () => {
    const panel = () => el.querySelector('[role="tabpanel"]') as HTMLElement;
    const controls = () => tabs().map((t) => t.getAttribute('aria-controls'));
    expect(controls()).toEqual(['ad-panel', null, null, null, null]);
    expect(panel().id).toBe('ad-panel');
    expect(panel().getAttribute('aria-labelledby')).toBe(tabs()[0].id);
    tabs()[2].click();
    await settle(2);
    expect(controls()).toEqual([null, null, 'ad-panel', null, null]);
    expect(panel().getAttribute('aria-labelledby')).toBe(tabs()[2].id);
  });

  it('Arrow, Home and End keys move the selection and the focus (wrapping)', async () => {
    tabs()[0].focus();
    await key(tabs()[0], 'ArrowRight');
    expect(selected()[1]).toBe('true');
    expect(document.activeElement).toBe(tabs()[1]);
    await key(tabs()[1], 'End');
    expect(selected()[4]).toBe('true');
    expect(document.activeElement).toBe(tabs()[4]);
    await key(tabs()[4], 'ArrowRight');
    expect(selected()[0]).toBe('true');
    expect(document.activeElement).toBe(tabs()[0]);
    await key(tabs()[0], 'ArrowLeft');
    expect(selected()[4]).toBe('true');
    await key(tabs()[4], 'Home');
    expect(selected()[0]).toBe('true');
    expect(document.activeElement).toBe(tabs()[0]);
  });
});
