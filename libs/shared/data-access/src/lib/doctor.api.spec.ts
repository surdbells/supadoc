import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { API_CONFIG } from './api-config';
import { DOCUMENT_VIEWER_HEADER, DoctorApi } from './doctor.api';

const base = 'https://api.example.test';
const OK = { status: 'success', message: 'OK', data: null };

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_CONFIG, useValue: { baseUrl: `${base}/` } },
    ],
  });
  return { doctor: TestBed.inject(DoctorApi), http: TestBed.inject(HttpTestingController) };
}

describe('DoctorApi (time zones, availability, view-only documents)', () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => (s = setup()));
  afterEach(() => s.http.verify());

  it('saves the time zone with PUT /doctor/timezone', () => {
    s.doctor.setTimeZone({ timezone: 'America/Chicago', source: 'manual', shift_slots: true }).subscribe();
    const req = s.http.expectOne(`${base}/api/doctor/timezone`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ timezone: 'America/Chicago', source: 'manual', shift_slots: true });
    req.flush(OK);
  });

  it('sends tz on the availability list, and scope + tz on delete', () => {
    s.doctor.availability('2026-11-01', '2026-11-30', 'America/Chicago').subscribe();
    const list = s.http.expectOne((r) => r.url === `${base}/api/doctor/availability`);
    expect(list.request.method).toBe('GET');
    expect(list.request.params.get('from')).toBe('2026-11-01');
    expect(list.request.params.get('to')).toBe('2026-11-30');
    expect(list.request.params.get('tz')).toBe('America/Chicago');
    list.flush(OK);

    s.doctor.deleteAvailability('a/b', 'following', 'America/Chicago').subscribe();
    const del = s.http.expectOne((r) => r.url === `${base}/api/doctor/availability/a%2Fb`);
    expect(del.request.method).toBe('DELETE');
    expect(del.request.params.get('scope')).toBe('following');
    expect(del.request.params.get('tz')).toBe('America/Chicago');
    del.flush({ status: 'success', message: '3 times removed', data: { deleted: 3, kept_booked: 1 } });

    s.doctor.deleteAvailability('x').subscribe();
    const one = s.http.expectOne((r) => r.url === `${base}/api/doctor/availability/x`);
    expect(one.request.params.get('scope')).toBe('one');
    expect(one.request.params.has('tz')).toBe(false);
    one.flush(OK);
  });

  it('posts a repeating publish as given', () => {
    const input = { date: '2026-11-09', start: '09:00', end: '24:00', duration: 30, tz: 'America/Chicago', repeat: 'days' as const, days: [1, 3, 5], weeks: 8 };
    s.doctor.addAvailability(input).subscribe();
    const req = s.http.expectOne(`${base}/api/doctor/availability`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(input);
    req.flush(OK);
  });

  it('fetches a document for the viewer with X-SD-Viewer: 1 and reads the view headers', async () => {
    const view = firstValueFrom(s.doctor.patientDocumentView('ap 1', 'doc/1'));
    const req = s.http.expectOne(`${base}/api/doctor/appointments/ap%201/patient-documents/doc%2F1/file`);
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get(DOCUMENT_VIEWER_HEADER)).toBe('1');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), {
      headers: {
        'Content-Type': 'application/pdf',
        'X-SD-View-Ref': 'VM-7F3A2C1D',
        'X-SD-Viewed-At': '2026-11-04T14:05:09+00:00',
      },
    });
    const out = await view;
    expect(out.mime).toBe('application/pdf');
    expect(out.viewRef).toBe('VM-7F3A2C1D');
    expect(out.viewedAt).toBe('2026-11-04T14:05:09+00:00');
    expect(out.blob.size).toBeGreaterThan(0);
  });

  it('a missing or malformed view ref is null, and the print record then sends {}', async () => {
    const view = firstValueFrom(s.doctor.patientDocumentView('ap1', 'doc1'));
    s.http
      .expectOne(`${base}/api/doctor/appointments/ap1/patient-documents/doc1/file`)
      .flush(new Blob(['x'], { type: 'image/png' }), { headers: { 'X-SD-View-Ref': 'vm-7f3a2c1d' } });
    const out = await view;
    expect(out.viewRef).toBeNull();
    expect(out.mime).toBe('image/png');
    expect(Number.isFinite(Date.parse(out.viewedAt))).toBe(true);

    s.doctor.patientDocumentPrinted('ap1', 'doc1', out.viewRef).subscribe();
    const bare = s.http.expectOne(`${base}/api/doctor/appointments/ap1/patient-documents/doc1/printed`);
    expect(bare.request.method).toBe('POST');
    expect(bare.request.body).toEqual({});
    bare.flush({ status: 'success', message: 'Recorded', data: { recorded: true } });

    s.doctor.patientDocumentPrinted('ap1', 'doc1', 'VM-7F3A2C1D').subscribe();
    const withRef = s.http.expectOne(`${base}/api/doctor/appointments/ap1/patient-documents/doc1/printed`);
    expect(withRef.request.body).toEqual({ view_ref: 'VM-7F3A2C1D' });
    withRef.flush(OK);
  });
});
