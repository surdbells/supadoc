import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AdminDashboardApi } from './admin-dashboard.api';
import { API_CONFIG } from './api-config';
import { SpecialistsApi } from './specialists.api';

describe('AdminDashboardApi + specialist photo', () => {
  let http: HttpTestingController;
  const base = 'https://api.example.test';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_CONFIG, useValue: { baseUrl: `${base}/` } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('asks for the period on the given calendar, and can skip the cache', () => {
    const api = TestBed.inject(AdminDashboardApi);

    api.get('7d', { tz: 'Africa/Lagos' }).subscribe();
    const first = http.expectOne((r) => r.url === `${base}/api/admin/dashboard`);
    expect(first.request.method).toBe('GET');
    expect(first.request.params.get('period')).toBe('7d');
    expect(first.request.params.get('tz')).toBe('Africa/Lagos');
    expect(first.request.params.has('refresh')).toBe(false);
    first.flush({ status: 'success', message: 'OK', data: {} });

    api.get(undefined, { refresh: true }).subscribe();
    const second = http.expectOne((r) => r.url === `${base}/api/admin/dashboard`);
    expect(second.request.params.get('period')).toBe('today');
    expect(second.request.params.get('tz')).toBeTruthy(); // the browser's zone
    expect(second.request.params.get('refresh')).toBe('1');
    second.flush({ status: 'success', message: 'OK', data: {} });
  });

  it('uploads the photo as multipart `photo` with progress, and removes it', () => {
    const api = TestBed.inject(SpecialistsApi);
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'face.png', { type: 'image/png' });
    const types: HttpEventType[] = [];

    api.uploadPhoto('a/b', file).subscribe((e) => types.push(e.type));
    const upload = http.expectOne(`${base}/api/specialists/a%2Fb/photo`);
    expect(upload.request.method).toBe('POST');
    expect(upload.request.reportProgress).toBe(true);
    const body = upload.request.body as FormData;
    expect(body.get('photo')).toBeInstanceOf(File);
    upload.flush({ status: 'success', message: 'Photo updated', data: { photo_url: '/uploads/avatars/x.png' } });
    expect(types).toContain(HttpEventType.Response);

    api.removePhoto('a/b').subscribe();
    const remove = http.expectOne(`${base}/api/specialists/a%2Fb/photo`);
    expect(remove.request.method).toBe('DELETE');
    remove.flush({ status: 'success', message: 'Photo removed', data: { photo_url: null } });
  });
});
