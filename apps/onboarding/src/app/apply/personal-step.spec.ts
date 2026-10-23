import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  buttonByText,
  D,
  draft,
  fail,
  flushAndSettle,
  HttpTestingController,
  ok,
  P,
  settle,
  stubDialogs,
  testProviders,
  textOf,
  typeInto,
} from '../../testing/onb-testing';
import { ApplicantSession } from '../core/applicant-session';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { OnbPersonalStep } from './personal-step';

describe('OnbPersonalStep', () => {
  let http: HttpTestingController;

  beforeAll(() => stubDialogs());

  beforeEach(async () => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    http = TestBed.inject(HttpTestingController);
    await TestBed.inject(ApplicationDraftStore).chooseRoute('ng');
  });

  afterEach(() => http.verify());

  async function create() {
    const fixture = TestBed.createComponent(OnbPersonalStep);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle(fixture);
    return { fixture, el };
  }

  async function fillValid(el: HTMLElement, fixture: Awaited<ReturnType<typeof create>>['fixture']) {
    typeInto(el.querySelector('#onb-first_name') as HTMLInputElement, 'Ada');
    typeInto(el.querySelector('#onb-last_name') as HTMLInputElement, 'Obi');
    typeInto(el.querySelector('#onb-email') as HTMLInputElement, 'ada.obi@example.com');
    typeInto(el.querySelector('#onb-phone') as HTMLInputElement, '8031234567');
    typeInto(el.querySelector('#onb-date_of_birth') as HTMLInputElement, '12031985');
    const gender = el.querySelector('#onb-gender') as HTMLSelectElement;
    gender.value = 'female';
    gender.dispatchEvent(new Event('change'));
    typeInto(el.querySelector('#onb-city') as HTMLInputElement, 'Lagos');
    await settle(fixture);
  }

  it('renders Step 1 of 7 with labelled fields and helpers', async () => {
    const { el } = await create();
    expect(textOf(el)).toContain('Step 1 of 7');
    expect(el.querySelector('h1')?.textContent).toContain('Personal Details');
    expect(el.querySelector('label[for="onb-phone"]')?.textContent).toContain('Phone number');
    expect(el.querySelector('#onb-email')?.getAttribute('aria-describedby')).toBe('onb-email-hint');
    expect(textOf(el)).toContain("We'll text you status updates.");
    expect(el.querySelector('#onb-country_of_residence')?.textContent).toContain('Nigeria');
    el.remove();
  });

  it('a Continue click with gaps shows every error and focuses the first field (D29)', async () => {
    const { fixture, el } = await create();
    const cont = buttonByText(el, 'Continue');
    expect(cont.getAttribute('aria-disabled')).toBe('true');
    cont.click();
    await settle(fixture);
    expect(textOf(el)).toContain('Enter your first name.');
    expect(textOf(el)).toContain('Enter a valid email address.');
    expect(document.activeElement?.id).toBe('onb-first_name');
    expect(el.querySelector('#onb-first_name')?.getAttribute('aria-invalid')).toBe('true');
    http.expectNone(`${P}/drafts`);
    el.remove();
  });

  it('creates the draft on Continue and moves to step 2', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { fixture, el } = await create();
    await fillValid(el, fixture);
    buttonByText(el, 'Continue').click();
    const req = http.expectOne(`${P}/drafts`);
    expect(req.request.body.personal).toMatchObject({
      first_name: 'Ada',
      phone: '+2348031234567',
      date_of_birth: '1985-03-12',
      gender: 'female',
      country_of_residence: 'NG',
    });
    req.flush(ok({ draft_token: 'tok', expires_in: 14400, draft: draft({ next_step: 'professional' }), resume_email_sent_to: 'ada***@example.com' }));
    await flushAndSettle(fixture);
    expect(TestBed.inject(ApplicantSession).draftToken()).toBe('tok');
    expect(nav).toHaveBeenCalledWith('/apply/professional');
    el.remove();
  });

  it('Save & continue later before a draft creates it (once) and shows where the email went', async () => {
    const { fixture, el } = await create();
    typeInto(el.querySelector('#onb-email') as HTMLInputElement, 'ada.obi@example.com');
    await settle(fixture);
    buttonByText(el, 'Save & continue later').click();
    const req = http.expectOne(`${P}/drafts`);
    expect(req.request.body.partial).toBe(true);
    req.flush(ok({ draft_token: 'tok', expires_in: 14400, draft: draft(), resume_email_sent_to: 'ada***@example.com' }));
    await flushAndSettle(fixture);
    http.expectNone(`${D}/resume-email`);
    expect(textOf(document.body)).toContain('Saved for later');
    expect(textOf(document.body)).toContain('ada***@example.com');
    fixture.destroy();
    el.remove();
  });

  it('maps the server 422 onto the fields', async () => {
    TestBed.inject(ApplicantSession).setDraftToken('tok');
    TestBed.inject(ApplicationDraftStore).draft.set(draft({ next_step: 'personal' }));
    const { fixture, el } = await create();
    await fillValid(el, fixture);
    buttonByText(el, 'Continue').click();
    const f = fail(422, 'Validation failed', { city: 'Enter your city.' });
    http.expectOne(`${D}/sections/personal`).flush(f.body, f.opts);
    await flushAndSettle(fixture);
    expect(el.querySelector('#onb-city-error')?.textContent).toContain('Enter your city.');
    el.remove();
  });
});
