import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Observable } from 'rxjs';
import { AdminDashboardApi } from './admin-dashboard.api';
import { API_CONFIG } from './api-config';
import { type ApiRequestOptions, ApiService, PASSIVE_REQUEST_HEADER } from './api.service';
import { AppointmentsApi } from './appointments.api';
import { DoctorApi } from './doctor.api';
import { LabRequestsApi } from './lab-requests.api';
import { MonitoringApi } from './monitoring.api';
import { WalletApi } from './wallet.api';

/*
 * Every API method a background request goes through (a poll, a timed report,
 * a re-read on returning to the tab) takes `{ passive: true }` and then sends
 * `X-SD-Passive: 1`, so the API never counts it as activity. Called without
 * it — as every user-initiated request is — the header is absent.
 */

const base = 'https://api.example.test';

interface Apis {
  api: ApiService;
  appointments: AppointmentsApi;
  doctor: DoctorApi;
  labs: LabRequestsApi;
  monitoring: MonitoringApi;
  dashboard: AdminDashboardApi;
  wallet: WalletApi;
}

interface Case {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly call: (a: Apis, options?: ApiRequestOptions) => Observable<unknown>;
}

const CASES: readonly Case[] = [
  { name: 'ApiService.request (doctor call: transcript poll, metrics)', method: 'GET', path: 'api/doctor/appointments/ap-1/transcript', call: (a, o) => a.api.request('get', 'api/doctor/appointments/ap-1/transcript', undefined, o) },
  { name: 'ApiService.request with a body (metrics report)', method: 'POST', path: 'api/doctor/appointments/ap-1/metrics', call: (a, o) => a.api.request('POST', 'api/doctor/appointments/ap-1/metrics', { rtt: 1 }, o) },
  { name: 'DoctorApi.presence', method: 'GET', path: 'api/doctor/appointments/presence', call: (a, o) => a.doctor.presence(o) },
  { name: 'DoctorApi.appointment', method: 'GET', path: 'api/doctor/appointments/ap-1', call: (a, o) => a.doctor.appointment('ap-1', o) },
  { name: 'DoctorApi.listLabOrders', method: 'GET', path: 'api/doctor/appointments/ap-1/lab-orders', call: (a, o) => a.doctor.listLabOrders('ap-1', o) },
  { name: 'DoctorApi.recordingState', method: 'GET', path: 'api/doctor/appointments/ap-1/recording', call: (a, o) => a.doctor.recordingState('ap-1', o) },
  { name: 'LabRequestsApi.list', method: 'GET', path: 'api/doctor/lab-requests', call: (a, o) => a.labs.list({ appointment_id: 'ap-1' }, o) },
  { name: 'LabRequestsApi.mine', method: 'GET', path: 'api/portal/lab-requests', call: (a, o) => a.labs.mine({ appointment_id: 'ap-1' }, o) },
  { name: 'AppointmentsApi.presence', method: 'GET', path: 'api/portal/appointments/presence', call: (a, o) => a.appointments.presence(o) },
  { name: 'AppointmentsApi.getMine', method: 'GET', path: 'api/portal/appointments/ap-1', call: (a, o) => a.appointments.getMine('ap-1', o) },
  { name: 'AppointmentsApi.callToken', method: 'GET', path: 'api/portal/appointments/ap-1/call-token', call: (a, o) => a.appointments.callToken('ap-1', o) },
  { name: 'AppointmentsApi.recordings', method: 'GET', path: 'api/portal/appointments/ap-1/recordings', call: (a, o) => a.appointments.recordings('ap-1', o) },
  { name: 'AppointmentsApi.reportMetric', method: 'POST', path: 'api/portal/appointments/ap-1/metrics', call: (a, o) => a.appointments.reportMetric('ap-1', { uplink: 1, downlink: 2, rtt: null }, o) },
  { name: 'AppointmentsApi.transcript', method: 'GET', path: 'api/portal/appointments/ap-1/transcript', call: (a, o) => a.appointments.transcript('ap-1', o) },
  { name: 'AppointmentsApi.prescriptions', method: 'GET', path: 'api/portal/appointments/ap-1/prescriptions', call: (a, o) => a.appointments.prescriptions('ap-1', o) },
  { name: 'AppointmentsApi.labOrders', method: 'GET', path: 'api/portal/appointments/ap-1/lab-orders', call: (a, o) => a.appointments.labOrders('ap-1', o) },
  { name: 'AppointmentsApi.carePlan', method: 'GET', path: 'api/portal/appointments/ap-1/care-plan', call: (a, o) => a.appointments.carePlan('ap-1', o) },
  { name: 'AppointmentsApi.referrals', method: 'GET', path: 'api/portal/appointments/ap-1/referrals', call: (a, o) => a.appointments.referrals('ap-1', o) },
  { name: 'AppointmentsApi.followUps', method: 'GET', path: 'api/portal/appointments/ap-1/follow-ups', call: (a, o) => a.appointments.followUps('ap-1', o) },
  { name: 'AppointmentsApi.followUpQuote', method: 'GET', path: 'api/portal/appointments/ap-1/follow-up/quote', call: (a, o) => a.appointments.followUpQuote('ap-1', undefined, o) },
  { name: 'AppointmentsApi.certificates', method: 'GET', path: 'api/portal/appointments/ap-1/certificates', call: (a, o) => a.appointments.certificates('ap-1', o) },
  { name: 'AppointmentsApi.consultationSummary', method: 'GET', path: 'api/portal/appointments/ap-1/consultation', call: (a, o) => a.appointments.consultationSummary('ap-1', o) },
  { name: 'AppointmentsApi.guests', method: 'GET', path: 'api/portal/appointments/ap-1/guests', call: (a, o) => a.appointments.guests('ap-1', o) },
  { name: 'WalletApi.wallet', method: 'GET', path: 'api/portal/wallet', call: (a, o) => a.wallet.wallet(undefined, o) },
  { name: 'MonitoringApi.overview', method: 'GET', path: 'api/admin/monitoring/overview', call: (a, o) => a.monitoring.overview(o) },
  { name: 'AdminDashboardApi.get', method: 'GET', path: 'api/admin/dashboard', call: (a, o) => a.dashboard.get('today', { tz: 'UTC', ...o }) },
];

describe('background requests are passive (X-SD-Passive)', () => {
  let apis: Apis;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_CONFIG, useValue: { baseUrl: `${base}/` } },
      ],
    });
    apis = {
      api: TestBed.inject(ApiService),
      appointments: TestBed.inject(AppointmentsApi),
      doctor: TestBed.inject(DoctorApi),
      labs: TestBed.inject(LabRequestsApi),
      monitoring: TestBed.inject(MonitoringApi),
      dashboard: TestBed.inject(AdminDashboardApi),
      wallet: TestBed.inject(WalletApi),
    };
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const sent = (c: Case) =>
    http.expectOne((r) => r.method === c.method && r.url === `${base}/${c.path}`, c.name);

  for (const c of CASES) {
    it(`${c.name}: passive with { passive: true }, active without`, () => {
      c.call(apis, { passive: true }).subscribe();
      const passive = sent(c);
      expect(passive.request.headers.get(PASSIVE_REQUEST_HEADER)).toBe('1');
      passive.flush({ status: 'success', message: 'OK', data: {} });

      // A user-initiated request (no options) counts as activity.
      c.call(apis).subscribe();
      const active = sent(c);
      expect(active.request.headers.has(PASSIVE_REQUEST_HEADER)).toBe(false);
      active.flush({ status: 'success', message: 'OK', data: {} });

      c.call(apis, { passive: false }).subscribe();
      const explicit = sent(c);
      expect(explicit.request.headers.has(PASSIVE_REQUEST_HEADER)).toBe(false);
      explicit.flush({ status: 'success', message: 'OK', data: {} });
    });
  }

  it('ApiService.request keeps the method, the body and the JSON response type with the header', () => {
    apis.api.request('post', 'api/x', { a: 1 }, { passive: true }).subscribe();
    const req = http.expectOne(`${base}/api/x`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ a: 1 });
    expect(req.request.responseType).toBe('json');
    expect(req.request.headers.get(PASSIVE_REQUEST_HEADER)).toBe('1');
    req.flush({});
  });

  it('AdminDashboardApi.get keeps its query (period, tz, refresh) when passive', () => {
    apis.dashboard.get('7d', { tz: 'Africa/Lagos', refresh: true, passive: true }).subscribe();
    const req = http.expectOne((r) => r.url === `${base}/api/admin/dashboard`);
    expect(req.request.params.get('period')).toBe('7d');
    expect(req.request.params.get('tz')).toBe('Africa/Lagos');
    expect(req.request.params.get('refresh')).toBe('1');
    expect(req.request.params.has('passive')).toBe(false);
    expect(req.request.headers.get(PASSIVE_REQUEST_HEADER)).toBe('1');
    req.flush({});
  });

  it('AppointmentsApi.followUpQuote keeps its slot when passive', () => {
    apis.appointments.followUpQuote('ap-1', '2026-11-06T09:00:00Z', { passive: true }).subscribe();
    const req = http.expectOne((r) => r.url === `${base}/api/portal/appointments/ap-1/follow-up/quote`);
    expect(req.request.params.get('scheduled_at')).toBe('2026-11-06T09:00:00Z');
    expect(req.request.headers.get(PASSIVE_REQUEST_HEADER)).toBe('1');
    req.flush({});
  });

  it('LabRequestsApi.list / mine keep their default group when passive', () => {
    apis.labs.list({ appointment_id: 'ap-1', per_page: 50 }, { passive: true }).subscribe();
    const list = http.expectOne((r) => r.url === `${base}/api/doctor/lab-requests`);
    expect(list.request.params.get('group')).toBe('all');
    expect(list.request.params.get('per_page')).toBe('50');
    list.flush({});
    apis.labs.mine({ appointment_id: 'ap-1' }, { passive: true }).subscribe();
    const mine = http.expectOne((r) => r.url === `${base}/api/portal/lab-requests`);
    expect(mine.request.params.get('group')).toBe('all');
    expect(mine.request.params.get('appointment_id')).toBe('ap-1');
    mine.flush({});
  });
});
