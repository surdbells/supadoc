import { TestBed } from '@angular/core/testing';
import { buttonByText, draft, HttpTestingController, settle, testProviders, textOf, tick } from '../../testing/onb-testing';
import { ApplicantSession } from '../core/applicant-session';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { MAX_QUALIFICATIONS, OnbQualificationsStep } from './qualifications-step';

describe('OnbQualificationsStep', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(ApplicantSession).setDraftToken('tok');
    TestBed.inject(ApplicationDraftStore).draft.set(draft({ next_step: 'qualifications' }));
  });

  afterEach(() => http.verify());

  async function create() {
    const fixture = TestBed.createComponent(OnbQualificationsStep);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle(fixture);
    return { fixture, el };
  }

  it('starts with the primary degree, which cannot be removed', async () => {
    const { el } = await create();
    expect(textOf(el)).toContain('Primary Medical Degree');
    expect(el.querySelector('[aria-label^="Remove additional qualification"]')).toBeNull();
    expect((el.querySelector('#onb-entries-0-degree') as HTMLInputElement).placeholder).toBe('e.g. MBBS');
    // Boxes 32px apart, "Add qualification" 16px under the last one (UI spec §1).
    const form = el.querySelector('form') as HTMLElement;
    expect(form.className).toContain('gap-4');
    expect(form.querySelector('[formArrayName="entries"]')?.className).toContain('gap-8');
    el.remove();
  });

  it('adds a box and focuses its Degree; removing focuses "Add qualification"', async () => {
    const { fixture, el } = await create();
    buttonByText(el, 'Add qualification').click();
    await settle(fixture);
    await tick();
    expect(textOf(el)).toContain('Additional Qualification 1');
    expect(document.activeElement?.id).toBe('onb-entries-1-degree');
    (el.querySelector('[aria-label="Remove additional qualification 1"]') as HTMLButtonElement).click();
    await settle(fixture);
    await tick();
    expect(textOf(el)).not.toContain('Additional Qualification 1');
    expect(document.activeElement?.id).toBe('onb-add-qualification');
    el.remove();
  });

  it('stops at 10 qualifications', async () => {
    const { fixture, el } = await create();
    for (let i = 1; i < MAX_QUALIFICATIONS; i++) {
      buttonByText(el, 'Add qualification').click();
      await settle(fixture);
    }
    expect(el.querySelectorAll('fieldset')).toHaveLength(10);
    expect(() => buttonByText(el, 'Add qualification')).toThrow();
    expect(textOf(el)).toContain('You can add up to 10 qualifications.');
    el.remove();
  });

  it('keys errors by entry on Continue', async () => {
    const { fixture, el } = await create();
    buttonByText(el, 'Continue').click();
    await settle(fixture);
    expect(el.querySelector('#onb-entries-0-degree-error')?.textContent).toContain('Enter the degree.');
    expect(document.activeElement?.id).toBe('onb-entries-0-degree');
    el.remove();
  });
});
