import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { DoctorApplicationsApi } from '@supadoc/data-access';
import { firstValueFrom } from 'rxjs';
import { D, fail, HttpTestingController, ok, P, testProviders, tick } from '../../testing/onb-testing';
import { ApplicantSession } from './applicant-session';
import { TrackStore } from './track.store';

describe('applicantTokenInterceptor', () => {
  let api: DoctorApplicationsApi;
  let session: ApplicantSession;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    api = TestBed.inject(DoctorApplicationsApi);
    session = TestBed.inject(ApplicantSession);
    http = TestBed.inject(HttpTestingController);
    session.setDraftToken('draft-tok');
    session.setAccessToken('track-tok');
  });

  afterEach(() => http.verify());

  it('sends the draft token to drafts/current URLs only', () => {
    api.getDraft().subscribe();
    expect(http.expectOne(D).request.headers.get('Authorization')).toBe('Bearer draft-tok');
  });

  it('sends the access token to the track status URLs', () => {
    api.status().subscribe();
    expect(http.expectOne(`${P}/track/status`).request.headers.get('Authorization')).toBe('Bearer track-tok');
    api.withdraw({ confirm: true }).subscribe();
    expect(http.expectOne(`${P}/track/withdraw`).request.headers.get('Authorization')).toBe('Bearer track-tok');
  });

  it('sends no token to config, drafts, resume or track/start', () => {
    api.config$().subscribe();
    api.createDraft({ licence_route: 'ng', personal: {} }).subscribe();
    api.resumeWithCode({ email: 'a@b.co', draft_code: 'ABC123' }).subscribe();
    api.trackStart({ reference: 'R', contact: 'c' }).subscribe();
    for (const url of [`${P}/config`, `${P}/drafts`, `${P}/drafts/resume`, `${P}/track/start`]) {
      expect(http.expectOne(url).request.headers.has('Authorization')).toBe(false);
    }
  });

  for (const [status, code] of [
    [401, 'applicant_token_invalid'],
    [404, 'draft_not_found'],
    [409, 'draft_submitted'],
  ] as const) {
    it(`drops the draft token on ${status} ${code}`, async () => {
      const call = firstValueFrom(api.getDraft()).catch((e: unknown) => e);
      const f = fail(status, 'Ended', { code, reference: 'GVM-DR-2026-54321' });
      http.expectOne(D).flush(f.body, f.opts);
      await call;
      expect(session.draftToken()).toBeNull();
      expect(session.accessToken()).toBe('track-tok');
    });
  }

  it('routes draft_submitted to the Track modal with the reference prefilled', async () => {
    const router = TestBed.inject(Router);
    const nav = vi.spyOn(router, 'navigateByUrl');
    const call = firstValueFrom(api.saveSection('personal', { values: {} })).catch((e: unknown) => e);
    const f = fail(409, 'Already submitted', { code: 'draft_submitted', reference: 'GVM-DR-2026-54321' });
    http.expectOne(`${D}/sections/personal`).flush(f.body, f.opts);
    await call;
    await tick();
    expect(TestBed.inject(TrackStore).prefillReference()).toBe('GVM-DR-2026-54321');
    expect(nav).toHaveBeenCalledWith('/?dialog=track');
  });

  it('keeps the draft token on other errors (e.g. a 422)', async () => {
    const call = firstValueFrom(api.saveSection('personal', { values: {} })).catch((e: unknown) => e);
    const f = fail(422, 'Validation failed', { email: 'Enter a valid email address.' });
    http.expectOne(`${D}/sections/personal`).flush(f.body, f.opts);
    await call;
    expect(session.draftToken()).toBe('draft-tok');
  });

  it('drops the access token on a 401 from a track URL', async () => {
    const call = firstValueFrom(api.status()).catch((e: unknown) => e);
    const f = fail(401, 'Ended', { code: 'applicant_token_invalid' });
    http.expectOne(`${P}/track/status`).flush(f.body, f.opts);
    await call;
    expect(session.accessToken()).toBeNull();
    expect(session.draftToken()).toBe('draft-tok');
  });

  it('passes successful answers through untouched', async () => {
    const call = firstValueFrom(api.getDraft());
    http.expectOne(D).flush(ok({ id: 'x' }));
    expect((await call).data).toEqual({ id: 'x' });
  });
});
