import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { DialogService } from '@supadoc/ui';
import {
  buttonByText,
  D,
  doc,
  fail,
  flushAndSettle,
  fullDraft,
  HttpTestingController,
  ok,
  P,
  settle,
  stubDialogs,
  testProviders,
  textOf,
} from '../../testing/onb-testing';
import { ApplicantSession } from '../core/applicant-session';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { NOTICE, Notices } from '../core/notices';
import { DEFAULT_CONFIG } from '../core/onboarding-config.store';
import { OnbReview, reviewSections } from './review';

describe('OnbReview', () => {
  let http: HttpTestingController;

  beforeAll(() => stubDialogs());

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(ApplicantSession).setDraftToken('tok');
  });

  afterEach(() => http.verify());

  async function create(verified = true) {
    TestBed.inject(ApplicationDraftStore).draft.set(fullDraft({ email_verified: verified }));
    const fixture = TestBed.createComponent(OnbReview);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle(fixture);
    http.expectOne(`${P}/config`).flush(ok(DEFAULT_CONFIG));
    await flushAndSettle(fixture);
    return { fixture, el };
  }

  it('builds the rows in the review format', () => {
    const sections = reviewSections(fullDraft());
    const rows = Object.fromEntries(sections.flatMap((s) => s.rows.map((r) => [r.label, r.value])));
    expect(rows['Full name']).toBe('Ada Obi');
    expect(rows['Phone number']).toBe('+234 803 123 4567');
    expect(rows['Date of birth']).toBe('12 Mar 1985');
    expect(rows['Country / City']).toBe('Lagos, Nigeria');
    expect(rows['Experience']).toBe('8 years');
    expect(rows['Workplace']).toBe('');
    expect(rows['Primary Medical Degree']).toBe('MBBS · University of Lagos · 2014');
    expect(rows['MDCN full registration certificate']).toBe('mdcn_certificate.pdf');
    expect(rows['Signature']).toBe('Ada Obi');
    expect(sections.map((s) => s.title)).toContain('Licence · Nigeria');
  });

  it('reads the abroad licence as "Regulator (Country)"', () => {
    const d = fullDraft({
      licence_route: 'abroad',
      documents: [doc('good_standing_certificate', { original_name: 'cgs.pdf' })],
    });
    d.sections.licence = {
      regulator_country: 'GB',
      regulator_name: 'General Medical Council',
      registration_number: '7012345',
      good_standing_issued_on: '2026-10-01',
    };
    const licence = reviewSections(d).find((s) => s.key === 'licence');
    expect(licence?.title).toBe('Licence · Abroad');
    expect(licence?.rows[0].value).toBe('General Medical Council (United Kingdom)');
    expect(licence?.rows[3].value).toBe('cgs.pdf');
  });

  it('shows "—" for empty values and Edit returns via ?return=review', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { el } = await create();
    expect(textOf(el)).toContain('—');
    (el.querySelector('[aria-label="Edit Licence · Nigeria"]') as HTMLButtonElement).click();
    expect(TestBed.inject(ApplicationDraftStore).returnToReview()).toBe(true);
    expect(nav).toHaveBeenCalledWith('/apply/licence?return=review');
    el.remove();
  });

  it('asks to confirm the email first, then submits', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { fixture, el } = await create(false);
    buttonByText(el, 'Submit application').click();
    await settle(fixture);
    const code = http.expectOne(`${D}/email-code`);
    code.flush(ok({ sent_to: 'ada***@example.com', expires_in: 600, resend_after: 60 }), { status: 202, statusText: 'Accepted' });
    await flushAndSettle(fixture);
    expect(textOf(document.body)).toContain('Confirm your email');
    expect(textOf(document.body)).toContain('We sent a 6-digit code to ada***@example.com. Enter it to submit your application.');
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('[role="group"] input'));
    '123456'.split('').forEach((d, i) => {
      boxes[i].value = d;
      boxes[i].dispatchEvent(new Event('input'));
    });
    await settle(fixture);
    buttonByText(document.body, 'Verify and submit').click();
    http.expectOne(`${D}/email-verify`).flush(ok(fullDraft({ email_verified: true })));
    await flushAndSettle(fixture);
    http
      .expectOne(`${D}/submit`)
      .flush(ok({ id: 'app-1', reference: 'GVM-DR-2026-80782', status: 'submitted', submitted_at: '', email: 'ada.obi@example.com', phone: '+2348031234567' }));
    await flushAndSettle(fixture);
    expect(nav).toHaveBeenCalledWith('/apply/submitted');
    expect(TestBed.inject(ApplicationDraftStore).submission()?.reference).toBe('GVM-DR-2026-80782');
    fixture.destroy();
    el.remove();
  });

  it('Cancel application on an ended session clears it and goes home (no error over an empty card)', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { fixture, el } = await create(true);
    buttonByText(el, 'Cancel application').click();
    await settle(fixture);
    buttonByText(document.body, 'Yes, cancel').click();
    const f = fail(401, 'Unauthorized', { code: 'applicant_token_invalid' });
    http.expectOne((r) => r.method === 'DELETE' && r.url === D).flush(f.body, f.opts);
    await flushAndSettle(fixture);
    expect(nav).toHaveBeenCalledWith('/');
    expect(TestBed.inject(Notices).peek('landing')).toBe(NOTICE.cancelled);
    expect(TestBed.inject(ApplicationDraftStore).hasToken()).toBe(false);
    expect(textOf(document.body)).not.toContain("We couldn't cancel your application");
    fixture.destroy();
    el.remove();
  });

  it('Cancel application on a draft submitted elsewhere does not claim it was cancelled', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { fixture, el } = await create(true);
    buttonByText(el, 'Cancel application').click();
    await settle(fixture);
    buttonByText(document.body, 'Yes, cancel').click();
    const f = fail(409, 'Conflict', { code: 'draft_submitted', reference: 'GVM-DR-2026-12345' });
    http.expectOne((r) => r.method === 'DELETE' && r.url === D).flush(f.body, f.opts);
    await flushAndSettle(fixture);
    expect(nav).toHaveBeenCalledWith('/?dialog=track');
    expect(nav).not.toHaveBeenCalledWith('/');
    expect(TestBed.inject(Notices).peek('landing')).toBeNull();
    fixture.destroy();
    el.remove();
  });

  it('explains a duplicate open application with a link to Check status', async () => {
    const { fixture, el } = await create(true);
    buttonByText(el, 'Submit application').click();
    const f = fail(409, 'Conflict', {
      code: 'duplicate_open_application',
      email: 'You already have an application in progress with this email. Check its status with your reference number.',
    });
    http.expectOne(`${D}/submit`).flush(f.body, f.opts);
    await flushAndSettle(fixture);
    expect(textOf(el)).toContain('You already have an application in progress');
    expect(Array.from(el.querySelectorAll('a')).some((a) => a.textContent?.includes('Check status'))).toBe(true);
    el.remove();
  });

  function beforeUnload(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  describe('unsaved values kept from a step', () => {
    it('warns before the tab closes only while a step holds unsaved values', async () => {
      const { fixture, el } = await create();
      expect(beforeUnload()).toBe(false);
      TestBed.inject(ApplicationDraftStore).pending.set('licence', { mdcn_number: 'MDCN/R/1' });
      expect(beforeUnload()).toBe(true);
      fixture.destroy();
      el.remove();
    });

    it('leaving the wizard asks first and dropping them clears them all; staying keeps them', async () => {
      const store = TestBed.inject(ApplicationDraftStore);
      const router = TestBed.inject(Router);
      const { fixture, el } = await create();
      const page = fixture.componentInstance;
      expect(page.canLeave()).toBe(true);

      store.pending.set('licence', { mdcn_number: 'MDCN/R/1' });
      vi.spyOn(router, 'currentNavigation').mockReturnValue({ finalUrl: router.parseUrl('/') } as never);
      const leave = vi.spyOn(TestBed.inject(DialogService), 'confirmLeave').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await expect(Promise.resolve(page.canLeave())).resolves.toBe(false);
      expect(leave.mock.calls[0][0]?.title).toBe('Leave your application?');
      expect(store.pending.has('licence')).toBe(true);
      await expect(Promise.resolve(page.canLeave())).resolves.toBe(true);
      expect(store.pending.size).toBe(0);
      fixture.destroy();
      el.remove();
    });

    it('moving within the wizard (Edit, a step link) keeps them without asking', async () => {
      const store = TestBed.inject(ApplicationDraftStore);
      const router = TestBed.inject(Router);
      const leave = vi.spyOn(TestBed.inject(DialogService), 'confirmLeave');
      const { fixture, el } = await create();
      store.pending.set('licence', { mdcn_number: 'MDCN/R/1' });
      vi.spyOn(router, 'currentNavigation').mockReturnValue({ finalUrl: router.parseUrl('/apply/licence?return=review') } as never);
      expect(fixture.componentInstance.canLeave()).toBe(true);
      expect(leave).not.toHaveBeenCalled();
      expect(store.pending.has('licence')).toBe(true);
      fixture.destroy();
      el.remove();
    });

    it('a session that ended under the page does not prompt', async () => {
      const leave = vi.spyOn(TestBed.inject(DialogService), 'confirmLeave');
      const { fixture, el } = await create();
      TestBed.inject(ApplicationDraftStore).pending.set('licence', { mdcn_number: 'MDCN/R/1' });
      TestBed.inject(ApplicantSession).setDraftToken(null);
      expect(fixture.componentInstance.canLeave()).toBe(true);
      expect(leave).not.toHaveBeenCalled();
      fixture.destroy();
      el.remove();
    });

    it('Submit asks first, naming the steps; Go back sends nothing', async () => {
      const store = TestBed.inject(ApplicationDraftStore);
      const confirm = vi.spyOn(TestBed.inject(DialogService), 'confirm').mockResolvedValue({ confirmed: false });
      const { fixture, el } = await create(true);
      store.pending.set('indemnity', { provider: 'MPS' });
      store.pending.set('personal', { first_name: 'Adaeze' });
      buttonByText(el, 'Submit application').click();
      await flushAndSettle(fixture);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0].title).toBe('Submit without your latest changes?');
      expect(confirm.mock.calls[0][0].message).toContain('Your changes to Personal Details and Indemnity');
      http.expectNone(`${D}/submit`);
      expect(store.pending.size).toBe(2);
      fixture.destroy();
      el.remove();
    });

    it('Submit anyway drops them and submits', async () => {
      const store = TestBed.inject(ApplicationDraftStore);
      const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      vi.spyOn(TestBed.inject(DialogService), 'confirm').mockResolvedValue({ confirmed: true });
      const { fixture, el } = await create(true);
      store.pending.set('indemnity', { provider: 'MPS' });
      buttonByText(el, 'Submit application').click();
      await flushAndSettle(fixture);
      expect(store.pending.size).toBe(0);
      http
        .expectOne(`${D}/submit`)
        .flush(ok({ id: 'app-1', reference: 'GVM-DR-2026-80782', status: 'submitted', submitted_at: '', email: 'ada.obi@example.com', phone: '+2348031234567' }));
      await flushAndSettle(fixture);
      expect(nav).toHaveBeenCalledWith('/apply/submitted');
      fixture.destroy();
      el.remove();
    });
  });

  it('explains an existing doctor account with a sign-in link', async () => {
    const { fixture, el } = await create(true);
    buttonByText(el, 'Submit application').click();
    const f = fail(409, 'Conflict', {
      code: 'already_registered',
      email: 'You already have a VideoMed doctor account. Sign in to the doctor portal instead.',
    });
    http.expectOne(`${D}/submit`).flush(f.body, f.opts);
    await flushAndSettle(fixture);
    const link = Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.includes('Sign in'));
    expect(link?.getAttribute('href')).toBe('https://doctor.dosthq.com/auth/login');
    el.remove();
  });
});
