import { TestBed } from '@angular/core/testing';
import { buttonByText, D, draft, HttpTestingController, settle, testProviders, textOf } from '../../testing/onb-testing';
import { ApplicantSession } from '../core/applicant-session';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { OnbIndemnityStep } from './indemnity-step';

describe('OnbIndemnityStep', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(ApplicantSession).setDraftToken('tok');
    TestBed.inject(ApplicationDraftStore).draft.set(draft({ next_step: 'indemnity' }));
  });

  afterEach(() => http.verify());

  it('has the provider, policy, expiry and certificate, and asks for all of them', async () => {
    const fixture = TestBed.createComponent(OnbIndemnityStep);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle(fixture);
    expect(textOf(el)).toContain('Step 6 of 7');
    expect((el.querySelector('#onb-provider') as HTMLInputElement).placeholder).toBe('e.g. Medical Protection Society');
    expect(textOf(el)).toContain('Proof of current professional indemnity cover');
    buttonByText(el, 'Continue').click();
    await settle(fixture);
    expect(textOf(el)).toContain('Enter your indemnity provider.');
    expect(textOf(el)).toContain('Cover expiry date must be in the future.');
    expect(textOf(el)).toContain('Add this document to continue.');
    http.expectNone(`${D}/sections/indemnity`);
    el.remove();
  });
});
