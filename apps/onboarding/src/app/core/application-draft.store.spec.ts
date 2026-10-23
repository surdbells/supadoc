import { TestBed } from '@angular/core/testing';
import { D, draft, fail, HttpTestingController, ok, P, testProviders, tick } from '../../testing/onb-testing';
import { ApplicantSession, DRAFT_TOKEN_KEY, ROUTE_KEY } from './applicant-session';
import { ApplicationDraftStore } from './application-draft.store';

describe('ApplicationDraftStore', () => {
  let store: ApplicationDraftStore;
  let session: ApplicantSession;
  let http: HttpTestingController;

  const personal = { email: 'ada.obi@example.com', first_name: 'Ada' };

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders() });
    store = TestBed.inject(ApplicationDraftStore);
    session = TestBed.inject(ApplicantSession);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('keeps the licence route locally until a draft exists', async () => {
    await store.chooseRoute('abroad');
    expect(sessionStorage.getItem(ROUTE_KEY)).toBe('abroad');
    expect(store.route()).toBe('abroad');
  });

  it('creates the draft on step 1 when there is no token (POST /drafts), then saves sections with PUT', async () => {
    await store.chooseRoute('ng');
    const created = store.savePersonal(personal, false);
    const req = http.expectOne(`${P}/drafts`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ licence_route: 'ng', personal, partial: false });
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush(ok({ draft_token: 'tok-1', expires_in: 14400, draft: draft({ next_step: 'professional' }), resume_email_sent_to: 'ada***@example.com' }), { status: 201, statusText: 'Created' });
    const result = await created;
    expect(result.sentTo).toBe('ada***@example.com');
    expect(sessionStorage.getItem(DRAFT_TOKEN_KEY)).toBe('tok-1');
    expect(sessionStorage.getItem(ROUTE_KEY)).toBeNull();

    const saved = store.saveSection('professional', { specialty: 'Cardiology' }, true);
    const put = http.expectOne(`${D}/sections/professional`);
    expect(put.request.method).toBe('PUT');
    expect(put.request.headers.get('Authorization')).toBe('Bearer tok-1');
    expect(put.request.body).toEqual({ values: { specialty: 'Cardiology' }, partial: true });
    put.flush(ok(draft({ next_step: 'licence' })));
    expect((await saved).next_step).toBe('licence');
  });

  it('Save & continue later on step 1 calls only POST /drafts (no second resume email)', async () => {
    const later = store.saveForLater('personal', personal);
    const req = http.expectOne(`${P}/drafts`);
    expect(req.request.body.partial).toBe(true);
    req.flush(ok({ draft_token: 'tok-2', expires_in: 14400, draft: draft(), resume_email_sent_to: 'ada***@example.com' }));
    expect(await later).toEqual({ sent_to: 'ada***@example.com' });
    http.expectNone(`${D}/resume-email`);
  });

  it('Save & continue later with a draft saves partially, then sends the resume email', async () => {
    session.setDraftToken('tok');
    const later = store.saveForLater('indemnity', { provider: 'MPS' });
    const put = http.expectOne(`${D}/sections/indemnity`);
    expect(put.request.body).toEqual({ values: { provider: 'MPS' }, partial: true });
    put.flush(ok(draft()));
    await tick();
    const mail = http.expectOne(`${D}/resume-email`);
    expect(mail.request.method).toBe('POST');
    mail.flush(ok({ sent_to: 'ada***@example.com', resend_after: 60 }), { status: 202, statusText: 'Accepted' });
    expect(await later).toEqual({ sent_to: 'ada***@example.com' });
  });

  it('ensureLoaded loads the draft for a stored token', async () => {
    expect(await store.ensureLoaded()).toBeNull();
    session.setDraftToken('tok');
    const loading = store.ensureLoaded();
    http.expectOne(D).flush(ok(draft({ next_step: 'licence' })));
    expect((await loading)?.next_step).toBe('licence');
    // Cached afterwards.
    expect((await store.ensureLoaded())?.next_step).toBe('licence');
  });

  for (const [status, code] of [
    [401, 'applicant_token_invalid'],
    [404, 'draft_not_found'],
    [409, 'draft_submitted'],
  ] as const) {
    it(`a ${status} ${code} drops the token and ensureLoaded answers null`, async () => {
      session.setDraftToken('tok');
      const loading = store.ensureLoaded();
      const f = fail(status, 'Ended', { code, reference: 'GVM-DR-2026-12345' });
      http.expectOne(D).flush(f.body, f.opts);
      expect(await loading).toBeNull();
      expect(session.draftToken()).toBeNull();
      expect(sessionStorage.getItem(DRAFT_TOKEN_KEY)).toBeNull();
    });
  }

  it('changes the route of an existing draft with PATCH', async () => {
    session.setDraftToken('tok');
    store.draft.set(draft({ licence_route: 'ng' }));
    const changing = store.chooseRoute('abroad');
    const req = http.expectOne(D);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ licence_route: 'abroad' });
    req.flush(ok(draft({ licence_route: 'abroad' })));
    await changing;
    expect(store.route()).toBe('abroad');
  });

  it('submits, keeps the submission in memory and forgets the draft', async () => {
    session.setDraftToken('tok');
    store.draft.set(draft());
    const submitting = store.submit();
    http.expectOne(`${D}/submit`).flush(
      ok({ id: 'app-1', reference: 'GVM-DR-2026-12345', status: 'submitted', submitted_at: '2026-10-23T10:00:00Z', email: 'a@b.co', phone: '+2348031234567' }),
    );
    await submitting;
    expect(store.submission()?.reference).toBe('GVM-DR-2026-12345');
    expect(session.draftToken()).toBeNull();
  });

  it('forgets the unsaved values of a draft whose token was dropped, not those typed before any draft', () => {
    store.pending.set('personal', { first_name: 'Ada' });
    TestBed.tick();
    expect(store.pending.size).toBe(1);
    session.setDraftToken('tok');
    TestBed.tick();
    store.pending.set('licence', { mdcn_number: 'MDCN/R/1' });
    session.setDraftToken(null); // expired, discarded or submitted elsewhere
    TestBed.tick();
    expect(store.pending.size).toBe(0);
  });

  it('discards the draft with DELETE', async () => {
    session.setDraftToken('tok');
    const discarding = store.discard();
    const req = http.expectOne(D);
    expect(req.request.method).toBe('DELETE');
    req.flush(ok({ deleted: true }));
    await discarding;
    expect(session.draftToken()).toBeNull();
  });
});
