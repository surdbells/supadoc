import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API_CONFIG } from './api-config';
import { ReferenceApi } from './reference.api';

describe('ReferenceApi', () => {
  let api: ReferenceApi;
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
    api = TestBed.inject(ReferenceApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('reads the public pick list and the staff list', () => {
    api.publicList('specialty').subscribe();
    const pub = http.expectOne(`${base}/api/public/reference/specialty`);
    expect(pub.request.method).toBe('GET');
    pub.flush({ status: 'success', message: 'OK', data: [] });

    api.list('specialty').subscribe();
    const staff = http.expectOne(`${base}/api/reference/specialty`);
    expect(staff.request.method).toBe('GET');
    staff.flush({ status: 'success', message: 'OK', data: [] });
  });

  it('creates, updates, reorders and removes items at their endpoints', () => {
    api.create('specialty', { label: 'Cardiology' }).subscribe();
    const create = http.expectOne(`${base}/api/reference/specialty`);
    expect(create.request.method).toBe('POST');
    expect(create.request.body).toEqual({ label: 'Cardiology' });
    create.flush({});

    api.update('specialty', 'a/b', { label: 'Heart', active: false }).subscribe();
    const update = http.expectOne(`${base}/api/reference/specialty/a%2Fb`);
    expect(update.request.method).toBe('PATCH');
    expect(update.request.body).toEqual({ label: 'Heart', active: false });
    update.flush({});

    api.reorder('specialty', ['x', 'y']).subscribe();
    const reorder = http.expectOne(`${base}/api/reference/specialty/reorder`);
    expect(reorder.request.method).toBe('POST');
    expect(reorder.request.body).toEqual({ ids: ['x', 'y'] });
    reorder.flush({});

    api.remove('specialty', 'x').subscribe();
    const remove = http.expectOne(`${base}/api/reference/specialty/x`);
    expect(remove.request.method).toBe('DELETE');
    remove.flush({});
  });
});
