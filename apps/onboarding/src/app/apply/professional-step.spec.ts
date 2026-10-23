import { TestBed } from '@angular/core/testing';
import { BASE, draft, HttpTestingController, ok, settle, testProviders, textOf, typeInto } from '../../testing/onb-testing';
import { ApplicantSession } from '../core/applicant-session';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { bioHelper, OnbProfessionalStep } from './professional-step';

describe('OnbProfessionalStep', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(ApplicantSession).setDraftToken('tok');
    TestBed.inject(ApplicationDraftStore).draft.set(draft({ next_step: 'professional' }));
  });

  afterEach(() => http.verify());

  async function create() {
    const fixture = TestBed.createComponent(OnbProfessionalStep);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle(fixture);
    http
      .expectOne(`${BASE}/api/public/reference/specialty`)
      .flush(ok([{ id: '1', code: 'cardiology', label: 'Cardiology', sort_order: 1 }]));
    await settle(fixture);
    return { fixture, el };
  }

  it('counts the bio live against 280 and caps it there', async () => {
    const { fixture, el } = await create();
    expect(textOf(el)).toContain(bioHelper(0));
    const bio = el.querySelector<HTMLTextAreaElement>('#onb-bio') as HTMLTextAreaElement;
    expect(bio.getAttribute('maxlength')).toBe('280');
    expect(bio.getAttribute('aria-describedby')).toBe('onb-bio-hint');
    typeInto(bio, 'Consultant cardiologist in Lagos.');
    await settle(fixture);
    expect(textOf(el)).toContain('33/280 · Shown to patients once you\'re approved');
    el.remove();
  });

  it('offers the specialty list and the languages (up to 5)', async () => {
    const { fixture, el } = await create();
    (el.querySelector('#onb-specialty') as HTMLButtonElement).click();
    await settle(fixture);
    expect(textOf(el)).toContain('Cardiology');
    (el.querySelector('#onb-languages') as HTMLButtonElement).click();
    await settle(fixture);
    expect(el.querySelector('fieldset legend')?.textContent).toContain('choose up to 5');
    el.remove();
  });

  it('validates on leaving the field, not on opening its dropdown or panel (§6.7)', async () => {
    const { fixture, el } = await create();
    const elsewhere = el.querySelector('#onb-workplace') as HTMLInputElement;
    const leave = (from: HTMLElement, to: EventTarget | null) =>
      from.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: to }));

    const specialty = el.querySelector('#onb-specialty') as HTMLButtonElement;
    specialty.click();
    await settle(fixture);
    const search = el.querySelector('input[placeholder="Search specialities"]') as HTMLInputElement;
    leave(specialty, search);
    const languages = el.querySelector('#onb-languages') as HTMLButtonElement;
    languages.click();
    await settle(fixture);
    leave(languages, el.querySelector('#onb-languages-panel input[type="checkbox"]'));
    await settle(fixture);
    expect(textOf(el)).not.toContain('Choose a speciality from the list.');
    expect(textOf(el)).not.toContain('Select at least one language.');
    expect(el.querySelector('[role="alert"]')).toBeNull();

    leave(search, elsewhere);
    leave(el.querySelector('#onb-languages-panel input[type="checkbox"]') as HTMLElement, elsewhere);
    await settle(fixture);
    expect(textOf(el)).toContain('Choose a speciality from the list.');
    expect(textOf(el)).toContain('Select at least one language.');
    el.remove();
  });

  it('has a years-of-experience stepper (0–60) with the e.g. placeholder', async () => {
    const { el } = await create();
    const years = el.querySelector<HTMLInputElement>('#onb-years_experience') as HTMLInputElement;
    expect(years.placeholder).toBe('e.g. 8');
    expect(years.getAttribute('aria-valuemax')).toBe('60');
    expect(el.querySelector('button[aria-label="Increase"]')).toBeTruthy();
    expect(el.querySelector('label[for="onb-workplace"]')?.textContent).toContain('(Optional)');
    el.remove();
  });
});
