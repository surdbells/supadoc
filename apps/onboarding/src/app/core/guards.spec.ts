import { TestBed } from '@angular/core/testing';
import { type ActivatedRouteSnapshot, type RouterStateSnapshot, UrlTree } from '@angular/router';
import { D, draft, fail, HttpTestingController, ok, testProviders } from '../../testing/onb-testing';
import { ApplicantSession } from './applicant-session';
import { ApplicationDraftStore } from './application-draft.store';
import { submittedGuard, trackSessionGuard, wizardStepGuard } from './guards';
import { NOTICE, Notices } from './notices';

const route = {} as ActivatedRouteSnapshot;
const state = {} as RouterStateSnapshot;

describe('guards', () => {
  let http: HttpTestingController;
  let session: ApplicantSession;

  const run = (guard: ReturnType<typeof wizardStepGuard>) =>
    TestBed.runInInjectionContext(() => guard(route, state)) as Promise<boolean | UrlTree> | boolean | UrlTree;
  const url = (r: unknown) => (r instanceof UrlTree ? r.toString() : r);

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders() });
    http = TestBed.inject(HttpTestingController);
    session = TestBed.inject(ApplicantSession);
  });

  afterEach(() => http.verify());

  it('personal needs a licence route', async () => {
    expect(url(await run(wizardStepGuard('personal')))).toBe('/apply');
    await TestBed.inject(ApplicationDraftStore).chooseRoute('ng');
    expect(await run(wizardStepGuard('personal'))).toBe(true);
  });

  it('later steps need a draft token', async () => {
    expect(url(await run(wizardStepGuard('licence')))).toBe('/?dialog=resume');
    expect(TestBed.inject(Notices).take('resume')).toBe(NOTICE.sessionEnded);
  });

  it('sends a step after next_step back to next_step', async () => {
    session.setDraftToken('tok');
    const result = run(wizardStepGuard('documents'));
    http.expectOne(D).flush(ok(draft({ next_step: 'professional' })));
    expect(url(await result)).toBe('/apply/professional');
  });

  it('lets an earlier or current step through', async () => {
    session.setDraftToken('tok');
    const result = run(wizardStepGuard('licence'));
    http.expectOne(D).flush(ok(draft({ next_step: 'licence' })));
    expect(await result).toBe(true);
  });

  it('a dead token goes to the Resume modal with the notice', async () => {
    session.setDraftToken('tok');
    const result = run(wizardStepGuard('professional'));
    const f = fail(401, 'Ended', { code: 'applicant_token_invalid' });
    http.expectOne(D).flush(f.body, f.opts);
    expect(url(await result)).toBe('/?dialog=resume');
    expect(TestBed.inject(Notices).take('resume')).toBe(NOTICE.sessionEnded);
  });

  it('review needs every step done', async () => {
    session.setDraftToken('tok');
    const result = run(wizardStepGuard('review'));
    http.expectOne(D).flush(ok(draft({ next_step: 'consent' })));
    expect(url(await result)).toBe('/apply/consent');
  });

  it('submitted needs the submission in memory', () => {
    expect(url(TestBed.runInInjectionContext(() => submittedGuard(route, state)))).toBe('/');
    TestBed.inject(ApplicationDraftStore).submission.set({
      id: 'a',
      reference: 'GVM-DR-2026-12345',
      status: 'submitted',
      submitted_at: '',
      email: '',
      phone: '',
    });
    expect(TestBed.runInInjectionContext(() => submittedGuard(route, state))).toBe(true);
  });

  it('status needs an access token', () => {
    expect(url(TestBed.runInInjectionContext(() => trackSessionGuard(route, state)))).toBe('/?dialog=track');
    session.setAccessToken('acc');
    expect(TestBed.runInInjectionContext(() => trackSessionGuard(route, state))).toBe(true);
  });
});
