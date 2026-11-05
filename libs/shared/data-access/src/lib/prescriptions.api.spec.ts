import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { API_CONFIG } from './api-config';
import { apiFileUrl, PrescriptionsApi } from './prescriptions.api';

const base = 'https://api.example.test';

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: API_CONFIG, useValue: { baseUrl: `${base}/` } }],
  });
  return { rx: TestBed.inject(PrescriptionsApi), http: TestBed.inject(HttpTestingController) };
}

describe('PrescriptionsApi', () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => (s = setup()));
  afterEach(() => s.http.verify());

  it('fileBlob GETs the relative signed link through HttpClient as a blob', async () => {
    const link = { url: '/api/public/prescriptions/file?token=t%2B1', expires_at: '2026-11-04T12:00:00Z', filename: 'GVM-RX-1.pdf' };
    const got = firstValueFrom(s.rx.fileBlob(link));
    const req = s.http.expectOne(`${base}/api/public/prescriptions/file?token=t%2B1`);
    expect(req.request.method).toBe('GET');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['%PDF-1.7'], { type: 'application/pdf' }));
    expect((await got).type).toBe('application/pdf');
  });

  it('link and staffLink POST { download }', () => {
    s.rx.link('rx 1', true).subscribe();
    const mine = s.http.expectOne(`${base}/api/portal/prescriptions/rx%201/link`);
    expect(mine.request.method).toBe('POST');
    expect(mine.request.body).toEqual({ download: true });
    mine.flush({ status: 'success', message: 'OK', data: null });

    s.rx.staffLink('rx-2').subscribe();
    const staff = s.http.expectOne(`${base}/api/admin/prescriptions/rx-2/link`);
    expect(staff.request.body).toEqual({ download: false });
    staff.flush({ status: 'success', message: 'OK', data: null });
  });

  it('apiFileUrl resolves a relative path against the base and keeps an absolute URL', () => {
    expect(apiFileUrl(`${base}/`, '/api/public/prescriptions/file?token=a')).toBe(`${base}/api/public/prescriptions/file?token=a`);
    expect(apiFileUrl(base, 'https://cdn.example.test/x')).toBe('https://cdn.example.test/x');
  });
});
