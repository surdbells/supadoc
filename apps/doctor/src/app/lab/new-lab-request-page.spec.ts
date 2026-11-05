import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { StaffAuthService, unsavedChangesGuard } from '@supadoc/auth';
import { LabRequestsApi } from '@supadoc/data-access';
import type { CreateLabRequestInput, LabOptionsDto, LabPatientPickDto } from '@supadoc/models';
import { DialogService, provideSupadocIcons } from '@supadoc/ui';
import { type Observable, of, Subject, throwError } from 'rxjs';
import { DoctorStandingStore } from '../standing/doctor-standing.store';
import { doctorStandingGuard } from '../standing/doctor-standing.guard';
import { CATALOGUE_CHANGED, IDEMPOTENCY_CONFLICT, NOT_CONSULTED } from './lab-composer';
import { LAB_ROUTES } from './lab.routes';
import { NewLabRequestPage, UNSAVED_LAB_LEAVE } from './new-lab-request-page';
import { LAB_ITEMS, labContext, labOptions, labRequest, must } from './testing/lab-fixtures';

@Component({ template: 'other' })
class OtherStub {}

const PICKS: LabPatientPickDto[] = [
  { patient_id: 'p1', name: 'Chika Osuji', email: 'chikaosuji@gmail.com', reference: 'P-1A2B3C4D', avatar_url: null, last_visit: '2026-10-26T10:00:00Z' },
  { patient_id: 'p2', name: 'Chika Osuji', email: 'c.osuji@yahoo.com', reference: 'P-9Z8Y7X6W', avatar_url: null, last_visit: null },
];

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('NewLabRequestPage', () => {
  let harness: RouterTestingHarness;
  let router: Router;
  let api: {
    options: ReturnType<typeof vi.fn>;
    context: ReturnType<typeof vi.fn>;
    patients: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn<(b: CreateLabRequestInput) => Observable<unknown>>>;
    list: ReturnType<typeof vi.fn>;
  };
  let confirmLeave: ReturnType<typeof vi.spyOn>;
  let leaveAnswer: boolean;
  let options: LabOptionsDto;

  async function setup(url: string, over: { askPregnancy?: boolean; hasSignature?: boolean } = {}) {
    options = labOptions({ has_signature: over.hasSignature ?? true });
    api = {
      options: vi.fn(() => of({ data: options })),
      context: vi.fn((pid: string, aid?: string | null) =>
        of({
          data: labContext(
            { ask_pregnancy: !!over.askPregnancy, appointment: aid ? { id: aid, scheduled_at: '2026-11-04T15:00:00Z' } : null },
            pid === 'p2' ? { id: 'p2', name: 'Bola Ade', first_name: 'Bola', email: 'bola@ade.com', reference: 'P-9Z8Y7X6W' } : {},
          ),
        }),
      ),
      patients: vi.fn(() => of({ data: PICKS, meta: { total: 2, page: 1, per_page: 20, total_pages: 1 } })),
      get: vi.fn((id: string) => of({ data: labRequest({ id, number: 'GVM-REQ-20261101-00007' }) })),
      create: vi.fn(() => of({ data: labRequest({ id: 'new1', number: 'GVM-REQ-20261105-00001', priority: 'urgent', sent_at: '2026-11-05T09:30:00Z' }) })),
      // The real list page (/prescriptions/labs) after Cancel / "Back to Laboratory & Diagnostics".
      list: vi.fn(() => of({ data: [], meta: { total: 0, page: 1, per_page: 20, total_pages: 0 } })),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          // The shipped config (as app.routes.ts mounts it): guards, runGuardsAndResolvers and all.
          { path: 'prescriptions/labs', loadChildren: () => import('./lab.routes').then((m) => m.LAB_ROUTES) },
          { path: '**', component: OtherStub },
        ]),
        provideLocationMocks(),
        provideSupadocIcons(),
        // doctorStandingGuard runs for real against a doctor in good standing.
        { provide: DoctorStandingStore, useValue: { load: () => Promise.resolve(null), code: () => null } },
        { provide: LabRequestsApi, useValue: api },
        { provide: StaffAuthService, useValue: { isAuthenticated: () => true, displayName: () => 'James Smith', subject: () => 's1' } },
      ],
    });
    leaveAnswer = true;
    confirmLeave = vi.spyOn(TestBed.inject(DialogService), 'confirmLeave').mockImplementation(() => Promise.resolve(leaveAnswer));
    router = TestBed.inject(Router);
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    await settle();
  }

  async function settle() {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  const root = () => harness.routeNativeElement as HTMLElement;
  const doc = () => document;
  const text = (el: Element | null = root()) => el?.textContent?.replace(/\s+/g, ' ') ?? '';
  const url = () => router.url;
  const button = (label: string, scope: ParentNode = root()) =>
    must(Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === label), 'element');

  async function pick(selectId: string, label: string) {
    const combo = must(doc().getElementById(selectId), String(selectId));
    combo.click();
    harness.detectChanges();
    const opt = Array.from(doc().querySelectorAll<HTMLElement>(`#${selectId}-listbox [role="option"]`)).find(
      (o) => o.textContent?.trim() === label,
    );
    if (!opt) throw new Error(`No option ${label} in ${selectId}`);
    opt.click();
    await settle();
  }

  async function type(id: string, value: string) {
    const input = doc().getElementById(id) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  async function tab(kind: 'lab' | 'imaging' | 'physiological') {
    must(doc().getElementById(`lab-tab-${kind}`), String(`lab-tab-${kind}`)).click();
    await settle();
  }

  const status = () => root().querySelector('doc-lab-composer [role="status"]')?.textContent?.trim();
  /** The open dialog showing this title (fails the test when there is none). */
  const dialogEl = (title: string) =>
    must(
      Array.from(doc().querySelectorAll('dialog')).find((d) => d.open && d.textContent?.includes(title)),
      `dialog "${title}"`,
    );

  /** A complete, valid form: FBC + question. */
  async function fillValid() {
    await pick('lab-quick', 'FBC');
    await type('lab-question', 'Suspected iron-deficiency anaemia');
  }

  async function openPreview() {
    must(doc().getElementById('lab-preview-button'), String('lab-preview-button')).click();
    await settle();
  }

  async function attestAndSend() {
    const box = doc().getElementById('lab-attest') as HTMLInputElement;
    box.click();
    await settle();
    button('Send to Patient', dialogEl('Preview request')).click();
    await settle();
  }

  describe('picker', () => {
    it('lists consulted patients; each card is a button named by its content (reference, email), no aria-label', async () => {
      await setup('/prescriptions/labs/new');
      expect(api.patients).toHaveBeenCalled();
      expect(text()).toContain('Choose a patient');
      const cards = Array.from(root().querySelectorAll<HTMLButtonElement>('ul button'));
      expect(cards.length).toBe(2);
      expect(cards[0].hasAttribute('aria-label')).toBe(false);
      expect(text(cards[0])).toContain('Ref P-1A2B3C4D · chikaosuji@gmail.com · Last visit 26 Oct 2026');
      expect(text(cards[1])).toContain('Ref P-9Z8Y7X6W · c.osuji@yahoo.com');
      expect(text(cards[1])).not.toContain('Last visit');
    });

    it('choosing navigates with only patientId (a stale appointmentId / from is dropped) and opens the composer', async () => {
      await setup('/prescriptions/labs/new?appointmentId=ap-9&from=lr-old');
      Array.from(root().querySelectorAll<HTMLButtonElement>('ul button'))[0].click();
      await settle();
      expect(url()).toBe('/prescriptions/labs/new?patientId=p1');
      expect(api.context).toHaveBeenLastCalledWith('p1', null);
      expect(api.get).not.toHaveBeenCalled();
      expect(root().querySelector('doc-lab-composer')).not.toBeNull();
      expect(text(root().querySelector('doc-lab-patient-card'))).toContain('Ref P-1A2B3C4D');
    });
  });

  describe('composer page', () => {
    it('Back with nothing entered goes to the picker with no params, without asking', async () => {
      await setup('/prescriptions/labs/new?patientId=p1&appointmentId=ap-1');
      button('Back').click();
      await settle();
      expect(url()).toBe('/prescriptions/labs/new');
      expect(confirmLeave).not.toHaveBeenCalled();
    });

    it('"Change patient?" then confirm: one prompt only, and the picker shows', async () => {
      await setup('/prescriptions/labs/new?patientId=p1');
      await fillValid();
      button('Back').click();
      await settle();
      await wait();
      await settle();
      expect(confirmLeave).toHaveBeenCalledTimes(1);
      expect(confirmLeave.mock.calls[0][0]).toMatchObject({
        title: 'Change patient?',
        message: 'Your selections for Chika will be lost.',
        confirmLabel: 'Change patient',
        cancelLabel: 'Keep editing',
      });
      expect(url()).toBe('/prescriptions/labs/new');
      expect(root().querySelector('doc-lab-patient-picker')).not.toBeNull();
    });

    it('browser Back from a dirty composer asks with the unsaved copy (query-param-only navigation)', async () => {
      await setup('/prescriptions/labs/new');
      // Popstate navigations (as the app's bootstrap sets up).
      router.setUpLocationChangeListener();
      await router.navigateByUrl('/prescriptions/labs/new?patientId=p1');
      await settle();
      await fillValid();
      leaveAnswer = false;
      TestBed.inject(Location).back();
      await settle();
      await wait();
      await settle();
      expect(confirmLeave).toHaveBeenCalledWith(UNSAVED_LAB_LEAVE);
      expect(UNSAVED_LAB_LEAVE).toMatchObject({
        title: 'Leave this request?',
        message: 'Nothing has been sent. If you leave now, your selections will be lost.',
        confirmLabel: 'Leave without sending',
        cancelLabel: 'Keep editing',
      });
      expect(root().querySelector('doc-lab-composer')).not.toBeNull();
      expect(url()).toBe('/prescriptions/labs/new?patientId=p1');
    });

    it('browser Back from a dirty composer leaves to the picker when the doctor confirms', async () => {
      await setup('/prescriptions/labs/new');
      router.setUpLocationChangeListener();
      await router.navigateByUrl('/prescriptions/labs/new?patientId=p1');
      await settle();
      await fillValid();
      TestBed.inject(Location).back();
      await settle();
      await wait();
      await settle();
      expect(confirmLeave).toHaveBeenCalledTimes(1);
      expect(url()).toBe('/prescriptions/labs/new');
      expect(root().querySelector('doc-lab-patient-picker')).not.toBeNull();
    });

    it('warns before unload only while dirty', async () => {
      await setup('/prescriptions/labs/new?patientId=p1');
      const ev = () => {
        const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
        window.dispatchEvent(e);
        return e.defaultPrevented;
      };
      expect(ev()).toBe(false);
      await fillValid();
      expect(ev()).toBe(true);
    });

    it('the shipped routes: every lab page is standing-guarded; `new` asks before leaving, also on query-param-only moves', async () => {
      for (const r of LAB_ROUTES) expect(r.canActivate).toContain(doctorStandingGuard);
      const entry = must(LAB_ROUTES.find((r) => r.path === 'new'), 'the new route');
      expect(entry.canDeactivate).toContain(unsavedChangesGuard);
      expect(entry.runGuardsAndResolvers).toBe('paramsOrQueryParamsChange');
      expect(await must(entry.loadComponent, 'loadComponent')()).toBe(NewLabRequestPage);
      // ':labId' must not swallow 'new'.
      expect(LAB_ROUTES.findIndex((r) => r.path === 'new')).toBeLessThan(LAB_ROUTES.findIndex((r) => r.path === ':labId'));
    });

    it('browser Back while "Send to Patient" is in flight: no "Nothing has been sent" prompt, it stays, and Sent follows', async () => {
      await setup('/prescriptions/labs/new');
      router.setUpLocationChangeListener();
      await router.navigateByUrl('/prescriptions/labs/new?patientId=p1');
      await settle();
      const reply = new Subject<unknown>();
      api.create.mockImplementation(() => reply);
      await fillValid();
      await openPreview();
      await attestAndSend();
      expect(button('Sending…', dialogEl('Preview request'))).toBeTruthy();
      TestBed.inject(Location).back();
      await settle();
      await wait();
      await settle();
      expect(confirmLeave).not.toHaveBeenCalled();
      expect(url()).toBe('/prescriptions/labs/new?patientId=p1');
      expect(root().querySelector('doc-lab-composer')).not.toBeNull();
      // The server answers: the Sent dialog shows, and leaving is free again.
      reply.next({ data: labRequest({ id: 'new1', number: 'GVM-REQ-20261105-00001' }) });
      reply.complete();
      await settle();
      expect(text(dialogEl('Request Sent'))).toContain('GVM-REQ-20261105-00001');
      expect(api.create).toHaveBeenCalledTimes(1);
    });

    it('warns before unload while a send is in flight, even for an unchanged duplicate (not dirty)', async () => {
      await setup('/prescriptions/labs/new');
      // A request that is complete as copied (FBC only, automatic specimen).
      const fbc = { ...labRequest().items[0], specimen_mode: 'auto' as const, specimen_code: null, specimen_label: null };
      api.get.mockImplementation((id: string) => of({ data: labRequest({ id, items: [fbc] }) }));
      await router.navigateByUrl('/prescriptions/labs/new?patientId=p1&from=lr-1');
      await settle();
      const ev = () => {
        const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
        window.dispatchEvent(e);
        return e.defaultPrevented;
      };
      expect(ev()).toBe(false);
      const reply = new Subject<unknown>();
      api.create.mockImplementation(() => reply);
      await openPreview();
      await attestAndSend();
      expect(api.create).toHaveBeenCalledTimes(1);
      expect(ev()).toBe(true);
      reply.error({ statusCode: 0 });
      await settle();
      expect(ev()).toBe(false);
    });

    it('Duplicate (same patient) pre-fills and says what was dropped; another patient\'s request is ignored', async () => {
      const req = labRequest({ items: [...labRequest().items, { ...labRequest().items[0], id: 'x', position: 3, code: 'GONE', label: 'Retired test', short: 'Retired' }] });
      await setup('/prescriptions/labs/new?patientId=p1&from=lr-7');
      api.get.mockImplementation(() => of({ data: { ...req, id: 'lr-7' } }));
      await router.navigateByUrl('/prescriptions/labs/new?patientId=p1&from=lr-8');
      await settle();
      expect((doc().getElementById('lab-question') as HTMLInputElement).value).toBe('Suspected iron-deficiency anaemia');
      expect(text()).toContain("Some tests from GVM-REQ-20261104-00012 are no longer in the list and weren't copied: Retired test.");
      // A request of another patient: no copy.
      api.get.mockImplementation(() => of({ data: labRequest({ patient: { id: 'p9', name: 'X', age: null, sex: null } }) }));
      await router.navigateByUrl('/prescriptions/labs/new?patientId=p2&from=lr-9');
      await settle();
      expect((doc().getElementById('lab-question') as HTMLInputElement).value).toBe('');
    });

    it('Duplicate from patient A, Back, choose B: B\'s form is empty and no duplicated_from is sent', async () => {
      await setup('/prescriptions/labs/new?patientId=p1&from=lr-1');
      expect((doc().getElementById('lab-question') as HTMLInputElement).value).toBe('Suspected iron-deficiency anaemia');
      button('Back').click();
      await settle();
      await wait();
      await settle();
      expect(url()).toBe('/prescriptions/labs/new');
      Array.from(root().querySelectorAll<HTMLButtonElement>('ul button'))[1].click();
      await settle();
      expect(url()).toBe('/prescriptions/labs/new?patientId=p2');
      expect((doc().getElementById('lab-question') as HTMLInputElement).value).toBe('');
      expect(text(root().querySelector('doc-lab-investigations-card'))).toContain('No tests added yet.');
      await fillValid();
      await openPreview();
      await attestAndSend();
      expect(api.create.mock.calls[0][0]).toMatchObject({ patient_id: 'p2', duplicated_from: null, appointment_id: null });
    });

    it('not consulted / another patient\'s consultation: an empty state with "Choose another patient"', async () => {
      await setup('/prescriptions/labs/new');
      api.context.mockImplementation(() => throwError(() => ({ statusCode: 422, errors: { patient_id: NOT_CONSULTED, code: 'not_consulted' } })));
      await router.navigateByUrl('/prescriptions/labs/new?patientId=p1');
      await settle();
      expect(text()).toContain(NOT_CONSULTED);
      api.context.mockImplementation(() => throwError(() => ({ statusCode: 422, errors: { appointment_id: 'This consultation is with another patient.' } })));
      await router.navigateByUrl('/prescriptions/labs/new?patientId=p2&appointmentId=ap-2');
      await settle();
      expect(text()).toContain('This consultation is with another patient.');
      button('Choose another patient').click();
      await settle();
      expect(url()).toBe('/prescriptions/labs/new');
    });
  });

  describe('composer', () => {
    it('every add path announces "{label} added. {n} tests on this tab." and a repeat says it is already added', async () => {
      await setup('/prescriptions/labs/new?patientId=p1');
      await pick('lab-quick', 'FBC');
      expect(status()).toBe('FBC - Full Blood Count added. 1 test on this tab.');
      await pick('lab-panel-select', 'FBC - Full Blood Count');
      expect(status()).toBe('FBC - Full Blood Count is already added.');
      await pick('lab-category', 'Single tests');
      await pick('lab-single-select', 'Malaria MP');
      expect(status()).toBe('Malaria MP added. 2 tests on this tab.');
      await pick('lab-category', 'Microbiology');
      expect(must(doc().getElementById('lab-micro-select'), String('lab-micro-select')).getAttribute('aria-disabled')).toBe('true');
      await pick('lab-site', 'Blood');
      await pick('lab-micro-select', 'Gram stain - Blood');
      expect(status()).toBe('Gram stain - Blood added. 3 tests on this tab.');
      // The search.
      const search = doc().getElementById('lab-search-lab') as HTMLInputElement;
      search.value = 'urine';
      search.dispatchEvent(new Event('input'));
      harness.detectChanges();
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await settle();
      expect(status()).toBe('Urinalysis added. 4 tests on this tab.');
      expect(doc().activeElement).toBe(search);
      await tab('imaging');
      await pick('lab-study', 'X-Ray - Chest');
      expect(status()).toBe('X-Ray - Chest added. 1 test on this tab.');
      await tab('physiological');
      await pick('lab-physio-select', 'ECG (12-lead)');
      expect(status()).toBe('ECG (12-lead) added. 1 test on this tab.');
      expect(must(doc().getElementById('lab-tab-lab'), String('lab-tab-lab')).getAttribute('aria-label')).toBe('Laboratory, 4 tests');
      // Removing from the chips.
      await tab('lab');
      must(doc().querySelector<HTMLButtonElement>('#lab-panel-lab [aria-label="Remove Malaria MP"]'), '#lab-panel-lab [aria-label="Remove Malaria MP"]').click();
      await settle();
      expect(status()).toBe('Malaria MP removed.');
    });

    it('Preview Request is aria-disabled and opens the validation modal with only the failing rows; Fix focuses the field', async () => {
      await setup('/prescriptions/labs/new?patientId=p1');
      const preview = must(doc().getElementById('lab-preview-button'), String('lab-preview-button'));
      expect(preview.getAttribute('aria-disabled')).toBe('true');
      await openPreview();
      const modal = dialogEl('A few things are needed before Previewing');
      expect(modal).not.toBeNull();
      const rows = Array.from(modal.querySelectorAll('li')).map((li) => li.querySelector('span')?.textContent?.trim());
      expect(rows).toEqual(['Add at least one test', 'Confirm indication']);
      must(modal.querySelector<HTMLButtonElement>('[aria-label="Fix: Confirm indication"]'), '[aria-label="Fix: Confirm indication"]').click();
      await settle();
      await wait(5);
      expect(doc().activeElement?.id).toBe('lab-question');
      // The same messages now show under their fields.
      expect(doc().getElementById('lab-question-error')?.textContent?.trim()).toBe('Confirm indication');
    });

    it('Fix for the safety screen switches to Imaging and focuses the first empty field', async () => {
      await setup('/prescriptions/labs/new?patientId=p1', { askPregnancy: true });
      await type('lab-question', 'Cough');
      await tab('imaging');
      await pick('lab-study', 'X-Ray - Chest');
      await tab('lab');
      await openPreview();
      const modal = dialogEl('A few things are needed before Previewing');
      must(modal.querySelector<HTMLButtonElement>('[aria-label="Fix: Complete the imaging safety screen"]'), '[aria-label="Fix: Complete the imaging safety screen"]').click();
      await settle();
      await wait(5);
      expect(must(doc().getElementById('lab-tab-imaging'), String('lab-tab-imaging')).getAttribute('aria-selected')).toBe('true');
      expect(doc().activeElement?.id).toBe('lab-safety-pregnant');
    });

    it('Fix for a manual specimen switches to Laboratory, activates the item and focuses its specimen', async () => {
      await setup('/prescriptions/labs/new?patientId=p1');
      await fillValid();
      await pick('lab-specimen-type', 'Choose manually');
      await tab('imaging');
      await openPreview();
      must(dialogEl('A few things are needed').querySelector<HTMLButtonElement>('[aria-label="Fix: Choose a specimen for FBC"]'), '[aria-label="Fix: Choose a specimen for FBC"]').click();
      await settle();
      await wait(5);
      expect(must(doc().getElementById('lab-tab-lab'), String('lab-tab-lab')).getAttribute('aria-selected')).toBe('true');
      expect(doc().activeElement?.id).toBe('lab-specimen-manual');
    });

    it('Preview shows the counts, leaves out empty rows and shows the pregnancy and fasting warnings', async () => {
      await setup('/prescriptions/labs/new?patientId=p1', { askPregnancy: true });
      await type('lab-question', 'Suspected anaemia');
      await type('lab-medication', '');
      await type('lab-allergies', '');
      await pick('lab-category', 'Single tests');
      await pick('lab-single-select', 'FBS');
      await type('lab-fasting-hours', '6');
      // Pregnant? Yes on the clinical card; 12 weeks.
      const yes = must(root().querySelector<HTMLInputElement>('input[name="lab-pregnant"]'), 'input[name="lab-pregnant"]');
      yes.click();
      await settle();
      await type('lab-weeks', '12');
      await tab('imaging');
      await pick('lab-safety-contrast', 'No');
      await pick('lab-safety-mobility', 'Walking');
      await pick('lab-study', 'X-Ray - Chest');
      await openPreview();
      const dlg = dialogEl('Preview request');
      const t = text(dlg);
      expect(t).toContain('Laboratory (1)');
      expect(t).toContain('Imaging (1)');
      expect(t).not.toContain('Physiological (');
      expect(t).not.toContain('Current medication');
      expect(t).not.toContain('Allergies');
      expect(t).toContain('Priority: Routine · Fasting: Yes, 6 hours · Pregnant: Yes, 12 weeks');
      expect(t).toContain('Safety · Contrast allergy: No · Mobility: Walking · Pregnant: Yes');
      expect(t).toContain('Pregnant patient: check this study is safe in pregnancy before sending.');
      expect(t).toContain('FBS usually needs 8 hours of fasting.');
    });

    it('Send is gated by the attestation, then sends the body; the Sent dialog follows and leaving no longer asks', async () => {
      await setup('/prescriptions/labs/new?patientId=p1&appointmentId=ap-1');
      await fillValid();
      await openPreview();
      const dlg = dialogEl('Preview request');
      const send = button('Send to Patient', dlg);
      expect(send.getAttribute('aria-disabled')).toBe('true');
      send.click();
      await settle();
      expect(api.create).not.toHaveBeenCalled();
      expect(doc().activeElement?.id).toBe('lab-attest');
      await attestAndSend();
      expect(api.create).toHaveBeenCalledTimes(1);
      const body = api.create.mock.calls[0][0];
      expect(body).toMatchObject({
        patient_id: 'p1',
        appointment_id: 'ap-1',
        catalogue_version: '2026-11.1',
        clinical_question: 'Suspected iron-deficiency anaemia',
        items: [{ code: 'FBC', specimen_mode: 'auto' }],
        attest: true,
        signature: { mode: 'saved' },
      });
      const sent = dialogEl('Request Sent');
      expect(text(sent)).toContain('GVM-REQ-20261105-00001 · Chika Osuji · Urgent');
      expect(text(sent)).toMatch(/Sent today at \d{1,2}:\d{2}/);
      expect(text(sent)).toContain('Laboratory (1)');
      expect(button('+ New Request', sent)).toBeTruthy();
      button('Back to Laboratory & Diagnostics', sent).click();
      await settle();
      expect(confirmLeave).not.toHaveBeenCalled();
      expect(url()).toBe('/prescriptions/labs');
    });

    it('without a saved signature, Send also needs the pad', async () => {
      await setup('/prescriptions/labs/new?patientId=p1', { hasSignature: false });
      await fillValid();
      await openPreview();
      const dlg = dialogEl('Preview request');
      expect(text(dlg)).toContain("You haven't saved a signature yet. Sign in the box.");
      expect(text(dlg)).toContain('Also save this as my signature');
      (doc().getElementById('lab-attest') as HTMLInputElement).click();
      await settle();
      expect(button('Send to Patient', dlg).getAttribute('aria-disabled')).toBe('true');
      button('Send to Patient', dlg).click();
      await settle();
      expect(api.create).not.toHaveBeenCalled();
    });

    it('a 422 is shown inline; not_consulted has its own copy', async () => {
      await setup('/prescriptions/labs/new?patientId=p1');
      api.create.mockImplementation(() => throwError(() => ({ statusCode: 422, errors: { clinical_question: 'Add the provisional diagnosis or clinical question' } })));
      await fillValid();
      await openPreview();
      await attestAndSend();
      const alert = dialogEl('Preview request').querySelector('[role="alert"]');
      expect(alert?.textContent?.trim()).toBe('Add the provisional diagnosis or clinical question');
      api.create.mockImplementation(() => throwError(() => ({ statusCode: 422, errors: { patient_id: 'x', code: 'not_consulted' } })));
      button('Send to Patient', dialogEl('Preview request')).click();
      await settle();
      expect(dialogEl('Preview request').querySelector('[role="alert"]')?.textContent?.trim()).toBe(NOT_CONSULTED);
    });

    it('a network failure keeps the same client key (retry is safe)', async () => {
      await setup('/prescriptions/labs/new?patientId=p1');
      api.create.mockImplementation(() => throwError(() => ({ statusCode: 0 })));
      await fillValid();
      await openPreview();
      await attestAndSend();
      expect(dialogEl('Preview request').querySelector('[role="alert"]')?.textContent?.trim()).toBe(
        "Couldn't send the request. Check your connection and try again.",
      );
      button('Send to Patient', dialogEl('Preview request')).click();
      await settle();
      expect(api.create.mock.calls[1][0].client_key).toBe(api.create.mock.calls[0][0].client_key);
    });

    it('409 idempotency_conflict: the message, Preview stays open, and a new client key', async () => {
      await setup('/prescriptions/labs/new?patientId=p1');
      api.create.mockImplementation(() => throwError(() => ({ statusCode: 409, errors: { code: 'idempotency_conflict' } })));
      await fillValid();
      await openPreview();
      await attestAndSend();
      const dlg = dialogEl('Preview request');
      expect(dlg).not.toBeNull();
      expect(dlg.querySelector('[role="alert"]')?.textContent?.trim()).toBe(IDEMPOTENCY_CONFLICT);
      button('Send to Patient', dlg).click();
      await settle();
      expect(api.create.mock.calls[1][0].client_key).not.toBe(api.create.mock.calls[0][0].client_key);
    });

    it('409 catalogue_changed: reloads the options, lists what was dropped, reopens Preview with a new client key', async () => {
      await setup('/prescriptions/labs/new?patientId=p1');
      await fillValid();
      await pick('lab-quick', 'Malaria MP');
      const first = vi.fn(() => throwError(() => ({ statusCode: 409, errors: { code: 'catalogue_changed', catalogue_version: '2026-12.1' } })));
      api.create.mockImplementation(first);
      const newer = labOptions({ catalogue_version: '2026-12.1', items: LAB_ITEMS.filter((i) => i.code !== 'MP') });
      api.options.mockImplementation(() => of({ data: newer }));
      await openPreview();
      await attestAndSend();
      expect(api.options).toHaveBeenCalledTimes(2);
      expect(text()).toContain('Some tests are no longer in the list and were removed: Malaria MP.');
      const dlg = dialogEl('Preview request');
      expect(text(dlg)).toContain(CATALOGUE_CHANGED);
      expect(text(dlg)).not.toContain('Malaria');
      api.create.mockImplementation(() => of({ data: labRequest({ id: 'n2' }) }));
      await attestAndSend();
      const second = api.create.mock.calls[1][0];
      expect(second.catalogue_version).toBe('2026-12.1');
      expect(second.client_key).not.toBe(api.create.mock.calls[0][0].client_key);
      expect(second.items.map((i) => i.code)).toEqual(['FBC']);
    });
  });
});
