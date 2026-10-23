import { TestBed } from '@angular/core/testing';
import type { LicenceRoute } from '@supadoc/models';
import { buttonByText, D, doc, draft, HttpTestingController, settle, testProviders, textOf } from '../../testing/onb-testing';
import { ApplicantSession } from '../core/applicant-session';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { formatDayMonthYear, goodStandingMinDate, clinicToday } from '../core/format';
import { OnbLicenceStep } from './licence-step';

describe('OnbLicenceStep', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(ApplicantSession).setDraftToken('tok');
  });

  afterEach(() => http.verify());

  async function create(route: LicenceRoute, docs = [] as ReturnType<typeof doc>[]) {
    TestBed.inject(ApplicationDraftStore).draft.set(draft({ licence_route: route, next_step: 'licence', documents: docs }));
    const fixture = TestBed.createComponent(OnbLicenceStep);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle(fixture);
    return { fixture, el };
  }

  it('Nigeria: MDCN banner, fields and the D3 certificate upload', async () => {
    const { el } = await create('ng');
    expect(el.querySelector('h1')?.textContent).toContain('Licence · Nigeria');
    expect(textOf(el)).toContain('We verify your registration directly with the Medical and Dental Council of Nigeria (MDCN)');
    expect(el.querySelector('#onb-mdcn_number')).toBeTruthy();
    expect(el.querySelector('#onb-full_registration_year')).toBeTruthy();
    expect(el.querySelector('#onb-licence_expires_on')).toBeTruthy();
    expect(textOf(el)).toContain('MDCN full registration certificate');
    expect(textOf(el)).toContain('The certificate MDCN issued when you were fully registered');
    expect(textOf(el)).toContain('PDF, PNG or JPG, up to 5MB');
    expect(el.querySelector('#onb-regulator_country')).toBeNull();
    el.remove();
  });

  it('Abroad: no MDCN banner, regulator fields and the Good Standing window', async () => {
    const { el } = await create('abroad');
    expect(el.querySelector('h1')?.textContent).toContain('Licence · Abroad');
    expect(textOf(el)).not.toContain('Medical and Dental Council of Nigeria');
    const min = formatDayMonthYear(goodStandingMinDate(clinicToday()));
    expect(textOf(el)).toContain(`Must be issued on or after ${min} (within the last 6 months).`);
    expect(textOf(el)).toContain('Certificate of Good Standing');
    expect(textOf(el)).toContain('Issued within the last 6 months');
    expect(el.querySelector('label[for="onb-registration_number"]')?.textContent).toContain('Licence or registration number');
    el.remove();
  });

  it('asks for the certificate on Continue when it is missing', async () => {
    const { fixture, el } = await create('ng');
    buttonByText(el, 'Continue').click();
    await settle(fixture);
    expect(textOf(el)).toContain('Add this document to continue.');
    http.expectNone(`${D}/sections/licence`);
    el.remove();
  });

  it('shows an uploaded certificate', async () => {
    const { el } = await create('ng', [doc('mdcn_certificate', { original_name: 'mdcn.pdf' })]);
    expect(textOf(el)).toContain('mdcn.pdf');
    expect(el.querySelector('[aria-label="Remove MDCN full registration certificate"]')).toBeTruthy();
    el.remove();
  });
});
