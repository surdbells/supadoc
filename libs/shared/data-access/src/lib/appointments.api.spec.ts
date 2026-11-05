import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { API_CONFIG } from './api-config';
import { AppointmentsApi } from './appointments.api';

const base = 'https://api.example.test';

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: API_CONFIG, useValue: { baseUrl: `${base}/` } }],
  });
  return { appointments: TestBed.inject(AppointmentsApi), http: TestBed.inject(HttpTestingController) };
}

describe('AppointmentsApi (clinical document PDFs)', () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => (s = setup()));
  afterEach(() => s.http.verify());

  it('documentPdf GETs my referral with format=pdf as a blob', async () => {
    const pdf = firstValueFrom(s.appointments.documentPdf('ap 1', 'referral', 'r/1'));
    const req = s.http.expectOne((r) => r.url === `${base}/api/portal/appointments/ap%201/documents/referral/r%2F1`);
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('format')).toBe('pdf');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
    expect((await pdf).size).toBeGreaterThan(0);
  });

  it('documentPdf for a certificate', () => {
    s.appointments.documentPdf('ap1', 'certificate', 'c1').subscribe();
    const req = s.http.expectOne((r) => r.url === `${base}/api/portal/appointments/ap1/documents/certificate/c1`);
    expect(req.request.urlWithParams).toBe(`${base}/api/portal/appointments/ap1/documents/certificate/c1?format=pdf`);
    req.flush(new Blob(['%PDF']));
  });

  it('the HTML route is unchanged (no format)', () => {
    s.appointments.document('ap1', 'referral', 'r1').subscribe();
    const req = s.http.expectOne(`${base}/api/portal/appointments/ap1/documents/referral/r1`);
    expect(req.request.params.has('format')).toBe(false);
    expect(req.request.responseType).toBe('text');
    req.flush('<html></html>');
  });
});
