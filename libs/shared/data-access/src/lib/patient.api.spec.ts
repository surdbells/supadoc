import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { SetTimeZoneInput } from '@supadoc/models';
import { API_CONFIG } from './api-config';
import { PatientApi } from './patient.api';

const base = 'https://api.example.test';

describe('PatientApi.setTimeZone', () => {
  let http: HttpTestingController;
  let patient: PatientApi;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_CONFIG, useValue: { baseUrl: base } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    patient = TestBed.inject(PatientApi);
  });
  afterEach(() => http.verify());

  it('PUTs the zone and source only (never shift_slots)', () => {
    const body: SetTimeZoneInput = { timezone: 'Africa/Lagos', source: 'auto', shift_slots: true };
    patient.setTimeZone(body).subscribe();
    const req = http.expectOne(`${base}/api/portal/me/timezone`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ timezone: 'Africa/Lagos', source: 'auto' });
    req.flush({
      status: 'success',
      message: 'Time zone saved',
      data: { timezone: 'Africa/Lagos', timezone_source: 'auto', changed: true },
    });
  });
});
