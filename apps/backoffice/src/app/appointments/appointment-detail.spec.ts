import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { StaffAuthService } from '@supadoc/auth';
import { API_CONFIG } from '@supadoc/data-access';
import type { AppointmentDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { AdminAppointmentDetail } from './appointment-detail';

const BASE = 'http://api.test';
const realResolved = Intl.DateTimeFormat.prototype.resolvedOptions;

/** Makes this browser report `tz` as its zone (the staff member's own). */
function staffZone(tz: string) {
  return vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...realResolved.call(this), timeZone: tz };
  });
}

/** Wed 4 Nov 2026, 15:00 UTC: 4:00 PM WAT, 9:00 AM CST (Chicago is on CST from 1 Nov). */
function appointment(over: { doctorTz?: string; patientTz?: string | null } = {}): AppointmentDto {
  return {
    id: 'a1',
    patient_id: 'p1',
    patient: { id: 'p1', name: 'Ada Obi', email: 'ada@example.test', ...('patientTz' in over ? { timezone: over.patientTz } : {}) },
    specialist: { id: 's1', name: 'Dr Bayo Ade', ...(over.doctorTz ? { timezone: over.doctorTz } : {}) },
    scheduled_at: '2026-11-04T15:00:00Z',
    ends_at: '2026-11-04T15:30:00Z',
    type: 'video',
    type_label: 'Video',
    status: 'confirmed',
    status_label: 'Confirmed',
    amount: '10000.00',
    payment_status: 'paid',
    refunded_amount: null,
    created_at: '2026-10-01T09:00:00Z',
  } as AppointmentDto;
}

describe('AdminAppointmentDetail — other parties’ times', () => {
  let http: HttpTestingController;

  async function open(a: AppointmentDto): Promise<HTMLElement> {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/appointments/a1', AdminAppointmentDetail);
    http.expectOne(`${BASE}/api/appointments/a1`).flush({ status: 'success', message: 'OK', data: a });
    harness.detectChanges();
    await harness.fixture.whenStable();
    return harness.routeNativeElement as HTMLElement;
  }

  const when = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('[data-testid="bo-appt-when"] span')).map((s) => s.textContent?.trim());
  const whenText = (el: HTMLElement) => el.querySelector('[data-testid="bo-appt-when"]')?.childNodes[0]?.textContent?.trim() ?? '';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'appointments/:id', component: AdminAppointmentDetail }]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
        { provide: StaffAuthService, useValue: { hasPermission: () => false, isAuthenticated: () => true } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  it("adds the doctor's time when it differs from the staff zone (and not the patient's when it doesn't)", async () => {
    staffZone('Africa/Lagos');
    const el = await open(appointment({ doctorTz: 'America/Chicago', patientTz: 'Africa/Lagos' }));
    expect(when(el)).toEqual(["Doctor's time: 9:00 AM CST"]);
    // The staff time is labelled once another clock is beside it.
    expect(whenText(el)).toMatch(/ WAT$/);
  });

  it("adds the patient's time for staff elsewhere, with the weekday when the date differs", async () => {
    staffZone('Pacific/Honolulu');
    const el = await open(appointment({ doctorTz: 'America/Chicago', patientTz: 'Africa/Lagos' }));
    // 15:00 UTC is 5:00 AM HST, 9:00 AM CST, 4:00 PM WAT — all Wednesday.
    expect(when(el)).toEqual(["Doctor's time: 9:00 AM CST", "Patient's time: 4:00 PM WAT"]);
    expect(whenText(el)).toMatch(/ HST$/);
  });

  it('shows nothing extra when the zones are the same or unknown', async () => {
    staffZone('Africa/Lagos');
    // Doctor on the clinic zone; the patient never set one (null).
    const el = await open(appointment({ doctorTz: 'Africa/Lagos', patientTz: null }));
    expect(when(el)).toEqual([]);
    expect(whenText(el)).not.toMatch(/ WAT$/);
  });

  it('shows nothing extra from an older API without zones', async () => {
    staffZone('America/Chicago');
    const el = await open(appointment());
    expect(when(el)).toEqual([]);
  });
});
