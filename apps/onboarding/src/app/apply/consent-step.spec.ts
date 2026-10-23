import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { buttonByText, D, draft, flushAndSettle, fullDraft, HttpTestingController, ok, P, settle, stubDialogs, testProviders, textOf, typeInto } from '../../testing/onb-testing';
import { ApplicantSession } from '../core/applicant-session';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { DEFAULT_CONFIG } from '../core/onboarding-config.store';
import { OnbConsentStep } from './consent-step';

describe('OnbConsentStep', () => {
  let http: HttpTestingController;

  beforeAll(() => stubDialogs());

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(ApplicantSession).setDraftToken('tok');
    const full = fullDraft();
    TestBed.inject(ApplicationDraftStore).draft.set(
      draft({ next_step: 'consent', sections: { ...full.sections, consent: null } }),
    );
  });

  afterEach(() => http.verify());

  async function create(terms: string | null = null) {
    const fixture = TestBed.createComponent(OnbConsentStep);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle(fixture);
    http.expectOne(`${P}/config`).flush(ok({ ...DEFAULT_CONFIG, legal_terms_url: terms }));
    await flushAndSettle(fixture);
    return { fixture, el };
  }

  it('Mark all ticks every statement and becomes Unmark all', async () => {
    const { fixture, el } = await create();
    const toggle = buttonByText(el, 'Mark all');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.click();
    await settle(fixture);
    const boxes = Array.from(el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(boxes.every((b) => b.checked)).toBe(true);
    expect(buttonByText(el, 'Unmark all').getAttribute('aria-pressed')).toBe('true');
    el.remove();
  });

  it('enables Review only when all three are ticked and the signature matches', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { fixture, el } = await create();
    const review = () => buttonByText(el, 'Review your application');
    buttonByText(el, 'Mark all').click();
    await settle(fixture);
    expect(review().getAttribute('aria-disabled')).toBe('true');
    typeInto(el.querySelector('#onb-signature_name') as HTMLInputElement, 'Ada Okafor');
    await settle(fixture);
    expect(review().getAttribute('aria-disabled')).toBe('true');
    typeInto(el.querySelector('#onb-signature_name') as HTMLInputElement, 'Ada Obi');
    await settle(fixture);
    expect(review().hasAttribute('aria-disabled')).toBe(false);
    review().click();
    const put = http.expectOne(`${D}/sections/consent`);
    expect(put.request.body.values).toMatchObject({ accept_terms: true, signature_name: 'Ada Obi', consent_version: '2026-10' });
    put.flush(ok(fullDraft()));
    await flushAndSettle(fixture);
    expect(nav).toHaveBeenCalledWith('/apply/review');
    el.remove();
  });

  it('Save & continue later keeps an unfinished consent (partial save, like the API), then sends the resume email', async () => {
    const { fixture, el } = await create();
    (el.querySelector('#onb-accept_terms') as HTMLInputElement).click();
    await settle(fixture);
    buttonByText(el, 'Save & continue later').click();
    const put = http.expectOne(`${D}/sections/consent`);
    expect(put.request.body.partial).toBe(true);
    expect(put.request.body.values).toMatchObject({
      accept_terms: true,
      authorise_verification: false,
      confirm_accurate: false,
      signature_name: '',
      consent_version: '2026-10',
    });
    put.flush(ok(draft({ next_step: 'consent' })));
    await flushAndSettle(fixture);
    http.expectOne(`${D}/resume-email`).flush(ok({ sent_to: 'ada***@example.com', resend_after: 60 }), { status: 202, statusText: 'Accepted' });
    await flushAndSettle(fixture);
    expect(textOf(document.body)).toContain('ada***@example.com');
    fixture.destroy();
    el.remove();
  });

  it('Save & continue later still refuses a signature that does not match the names', async () => {
    const { fixture, el } = await create();
    typeInto(el.querySelector('#onb-signature_name') as HTMLInputElement, 'Ada Okafor');
    await settle(fixture);
    buttonByText(el, 'Save & continue later').click();
    await settle(fixture);
    http.expectNone(`${D}/sections/consent`);
    expect(textOf(el)).toContain('Type your full name as it appears on your application.');
    el.remove();
  });

  it('shows the Terms words without a link while the URL is unset', async () => {
    const first = await create(null);
    expect(first.el.querySelector('a[target="_blank"]')).toBeNull();
    expect(textOf(first.el)).toContain('I accept the Terms of Service and Privacy Policy.');
    first.el.remove();
  });

  it('links the Terms in a new tab once the URL is set', async () => {
    const { el } = await create('https://legal.example.test/terms');
    const link = el.querySelector<HTMLAnchorElement>('a[target="_blank"]');
    expect(link?.textContent).toContain('Terms of Service');
    expect(link?.getAttribute('href')).toBe('https://legal.example.test/terms');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    el.remove();
  });
});
