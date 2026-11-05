import {
  addItem,
  emptyForm,
  fastingShortfall,
  fromRequest,
  isDirty,
  type LabFormState,
  preflight,
  QUICK_ADD_CODES,
  removeItem,
  revalidate,
  safetyComplete,
  safetyRequired,
  searchCatalogue,
  setFasting,
  setFastingHours,
  setPregnant,
  setSpecimen,
  setSpecimenMode,
  setText,
  tabCount,
  toCreateBody,
  toggleInfectionAlert,
} from './lab-composer-state';
import { cat, LAB_ITEMS, labContext, labOptions, labRequest } from './testing/lab-fixtures';

const opts = labOptions();
const ctx = labContext();

function form(...codes: string[]): LabFormState {
  return codes.reduce((s, c) => addItem(s, cat(c)), emptyForm(ctx));
}

describe('lab-composer-state', () => {
  describe('emptyForm', () => {
    it('pre-fills medication and allergies from the record, and mints a new client key each time', () => {
      const a = emptyForm(ctx);
      const b = emptyForm(ctx);
      expect(a.medication).toBe('Metformin 500 mg');
      expect(a.allergies).toBe('Penicillin (severe)');
      expect(a.prefilled).toEqual({ medication: true, allergies: true });
      expect(a.priority).toBe('routine');
      expect(a.clientKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(a.clientKey).not.toBe(b.clientKey);
      expect(emptyForm(labContext({ prefill: { medication: '', allergies: '' } })).prefilled).toEqual({ medication: false, allergies: false });
    });

    it('editing a pre-filled field drops the "from the record" note', () => {
      const s = setText(emptyForm(ctx), 'medication', 'None');
      expect(s.prefilled).toEqual({ medication: false, allergies: true });
    });
  });

  describe('addItem / removeItem', () => {
    it('FBC through Quick add and then through Routine panel is one item (both selects show it)', () => {
      let s = addItem(emptyForm(ctx), cat('FBC'), 'quick');
      s = addItem(s, cat('FBC'), 'panel');
      expect(s.items.map((i) => i.code)).toEqual(['FBC']);
      expect(s.lastPick.quick).toBe('FBC');
      expect(s.lastPick.panel).toBe('FBC');
      expect(s.activeLabCode).toBe('FBC');
    });

    it('lab items start on Automatic; imaging takes its default preparation', () => {
      const s = form('FBC', 'US-PELVIS', 'ECG12');
      expect(s.items[0]).toMatchObject({ kind: 'lab', specimenMode: 'auto', specimenCode: null, preparation: null });
      expect(s.items[1]).toMatchObject({ kind: 'imaging', preparation: 'full_bladder', specimenMode: null });
      expect(s.items[2]).toMatchObject({ kind: 'physiological', specimenMode: null, preparation: null });
      expect(s.activeImagingCode).toBe('US-PELVIS');
      expect(tabCount(s, 'lab')).toBe(1);
      expect(tabCount(s, 'imaging')).toBe(1);
    });

    it('removing an item clears every select that showed it, whatever path added it', () => {
      let s = addItem(emptyForm(ctx), cat('FBC'), 'quick');
      s = addItem(s, cat('FBC'), 'panel');
      s = addItem(s, cat('MP'), 'single');
      s = removeItem(s, 'FBC');
      expect(s.items.map((i) => i.code)).toEqual(['MP']);
      expect(s.lastPick).toMatchObject({ quick: null, panel: null, single: 'MP' });
      expect(s.activeLabCode).toBe('MP');
      expect(removeItem(s, 'MP').activeLabCode).toBeNull();
    });

    it('quick add is the designed order', () => {
      expect(QUICK_ADD_CODES).toEqual(['FBC', 'MP', 'RBS', 'HIV', 'WIDAL', 'UA', 'HBSAG']);
    });
  });

  describe('fasting', () => {
    it('FBS pre-fills 8 hours while Fasting? is unanswered', () => {
      const s = form('FBS');
      expect(s).toMatchObject({ fasting: true, fastingHours: '8', fastingSource: 'FBS' });
    });

    it('FBS then Lipid profile → 10 h from Lipid profile; Lipid then FBS stays 10', () => {
      expect(form('FBS', 'LIPID')).toMatchObject({ fasting: true, fastingHours: '10', fastingSource: 'Lipid profile' });
      expect(form('LIPID', 'FBS')).toMatchObject({ fasting: true, fastingHours: '10', fastingSource: 'Lipid profile' });
    });

    it('once the doctor edits the hours, adding Lipid no longer changes them — and the shortfall warns', () => {
      let s = setFastingHours(form('FBS'), '6');
      expect(s.fastingSource).toBeNull();
      s = addItem(s, cat('LIPID'));
      expect(s.fastingHours).toBe('6');
      expect(fastingShortfall(s, opts)).toEqual({ short: 'Lipid profile', hours: 10 });
      expect(fastingShortfall(setFastingHours(s, '12'), opts)).toBeNull();
    });

    it('answering No warns for the longest fasting item; nothing to warn about without one', () => {
      const s = setFasting(form('FBS', 'LIPID', 'FBC'), false);
      expect(s.fastingSource).toBeNull();
      expect(fastingShortfall(s, opts)).toEqual({ short: 'Lipid profile', hours: 10 });
      expect(fastingShortfall(setFasting(form('FBC'), false), opts)).toBeNull();
      expect(fastingShortfall(form('FBS'), opts)).toBeNull();
    });

    it('an answered "No" is never overwritten by adding a fasting test', () => {
      const s = addItem(setFasting(form('FBC'), false), cat('FBS'));
      expect(s.fasting).toBe(false);
    });

    it('removing FBS leaves the fasting answer', () => {
      const s = removeItem(form('FBS'), 'FBS');
      expect(s).toMatchObject({ fasting: true, fastingHours: '8' });
    });
  });

  describe('pregnancy and the safety screen', () => {
    const asked = labContext({ ask_pregnancy: true });

    it('is one answer: the clinical radio and the safety select set the same field', () => {
      const s = setPregnant(emptyForm(asked), true);
      expect(s.pregnant).toBe(true);
      expect(setPregnant(s, false).pregnant).toBe(false);
    });

    it('is required only once a study is added, and complete when every asked field is answered', () => {
      let s = form('FBC');
      expect(safetyRequired(s)).toBe(false);
      s = addItem(s, cat('XR-CHEST'));
      expect(safetyRequired(s)).toBe(true);
      s = { ...s, safety: { contrastAllergy: 'no', mobility: 'walking' } };
      expect(safetyComplete(s, false)).toBe(true);
      expect(safetyComplete(s, true)).toBe(false);
      expect(safetyComplete(setPregnant(s, false), true)).toBe(true);
    });
  });

  describe('preflight', () => {
    it('lists the failing rules in the modal order with their labels', () => {
      const asked = labContext({ ask_pregnancy: true });
      let s = emptyForm(asked);
      expect(preflight(s, asked, opts).map((i) => i.label)).toEqual(['Add at least one test', 'Confirm indication']);
      s = addItem(s, cat('XR-CHEST'));
      s = addItem(s, cat('FBC'));
      s = setSpecimenMode(s, 'FBC', 'manual');
      s = setFasting(s, true);
      s = setPregnant(s, true);
      s = setText(s, 'question', 'ab');
      expect(preflight(s, asked, opts)).toEqual([
        { key: 'indication', label: 'Confirm indication' },
        { key: 'safety', label: 'Complete the imaging safety screen' },
        { key: 'fasting_hours', label: 'Add the fasting hours' },
        { key: 'weeks', label: 'Add how many weeks pregnant' },
        { key: 'specimen', label: 'Choose a specimen for FBC', code: 'FBC' },
      ]);
      s = setText(s, 'question', 'Suspected anaemia');
      s = setFastingHours(s, '8');
      s = { ...s, weeksPregnant: '12', safety: { contrastAllergy: 'no', mobility: 'walking' } };
      s = setSpecimen(s, 'FBC', 'serum');
      expect(preflight(s, asked, opts)).toEqual([]);
    });

    it('rejects out-of-range hours and weeks', () => {
      const asked = labContext({ ask_pregnancy: true });
      let s = setText(form('FBC'), 'question', 'Fever');
      s = setFastingHours(setFasting(s, true), '25');
      expect(preflight(s, asked, opts).map((i) => i.key)).toEqual(['fasting_hours']);
      s = { ...setFastingHours(s, '24'), pregnant: true, weeksPregnant: '43' };
      expect(preflight(s, asked, opts).map((i) => i.key)).toEqual(['weeks']);
      // Weeks are only asked when Pregnant? is.
      expect(preflight(s, ctx, opts)).toEqual([]);
    });

    it('a microbiology item never needs a specimen', () => {
      const s = setText(form('GRAM-BLOOD'), 'question', 'Sepsis?');
      expect(preflight(setSpecimenMode(s, 'GRAM-BLOOD', 'manual'), ctx, opts)).toEqual([]);
    });
  });

  describe('toCreateBody', () => {
    it('builds the exact create body (Pregnant? left out when not asked)', () => {
      let s = form('FBC', 'GRAM-BLOOD', 'XR-CHEST', 'ECG12');
      s = setSpecimen(setSpecimenMode(s, 'FBC', 'manual'), 'FBC', 'serum');
      s = setText(s, 'question', '  Suspected iron-deficiency anaemia ');
      s = setText(s, 'history', 'Fatigue for 3 weeks');
      s = { ...s, purpose: 'diagnosis', transfusion: false, safety: { contrastAllergy: 'no', mobility: 'walking' } };
      s = toggleInfectionAlert(s, 'hiv', ['hiv', 'hep_b', 'hep_c', 'tb']);
      const body = toCreateBody(s, ctx, null, null, { mode: 'saved' }, '2026-11.1');
      expect(body).toEqual({
        client_key: s.clientKey,
        catalogue_version: '2026-11.1',
        patient_id: 'p1',
        appointment_id: null,
        duplicated_from: null,
        priority: 'routine',
        purpose: 'diagnosis',
        clinical_question: 'Suspected iron-deficiency anaemia',
        history: 'Fatigue for 3 weeks',
        medication: 'Metformin 500 mg',
        allergies: 'Penicillin (severe)',
        clinical: { fasting: null, fasting_hours: null, infection_alerts: ['hiv'], transfusion_3m: false },
        items: [
          { code: 'FBC', specimen_mode: 'manual', specimen_code: 'serum' },
          { code: 'GRAM-BLOOD', specimen_mode: 'auto' },
          { code: 'XR-CHEST', preparation_code: 'none' },
          { code: 'ECG12' },
        ],
        imaging_safety: { contrast_allergy: 'no', mobility: 'walking' },
        attest: true,
        signature: { mode: 'saved' },
      });
      expect('pregnant' in body.clinical).toBe(false);
      expect('weeks_pregnant' in body.clinical).toBe(false);
    });

    it('sends Pregnant? / weeks when asked, fasting hours as a number, and the appointment / duplicate ids', () => {
      const asked = labContext({ ask_pregnancy: true });
      let s = setText(addItem(emptyForm(asked), cat('FBS')), 'question', 'Diabetes?');
      s = { ...setPregnant(s, true), weeksPregnant: '12' };
      const body = toCreateBody(s, asked, 'ap-1', 'lr-0', { mode: 'drawn', image: 'data:image/png;base64,AA', save: true }, 'v2');
      expect(body.clinical).toEqual({ fasting: true, fasting_hours: 8, infection_alerts: [], transfusion_3m: null, pregnant: true, weeks_pregnant: 12 });
      expect(body).toMatchObject({ appointment_id: 'ap-1', duplicated_from: 'lr-0', catalogue_version: 'v2', imaging_safety: null });
      expect(body.signature).toEqual({ mode: 'drawn', image: 'data:image/png;base64,AA', save: true });
    });
  });

  describe('fromRequest (Duplicate)', () => {
    it('copies priority, purpose, question, history, items, infection alerts and mobility — nothing about the patient now', () => {
      const dto = labRequest({ priority: 'stat' });
      const { state, dropped } = fromRequest(dto, opts, ctx);
      expect(dropped).toEqual([]);
      expect(state).toMatchObject({
        priority: 'stat',
        purpose: 'diagnosis',
        question: 'Suspected iron-deficiency anaemia',
        history: 'Fatigue for 3 weeks',
        infectionAlerts: ['hiv', 'tb'],
        // Never copied: medication / allergies come from the record; these are asked again.
        medication: 'Metformin 500 mg',
        allergies: 'Penicillin (severe)',
        pregnant: null,
        fasting: null,
        transfusion: null,
        safety: { contrastAllergy: null, mobility: 'chair' },
      });
      expect(state.items.map((i) => [i.code, i.specimenMode, i.specimenCode, i.preparation])).toEqual([
        ['FBC', 'manual', 'serum', null],
        ['XR-CHEST', null, null, 'full_bladder'],
      ]);
      expect(state.clientKey).not.toBe('');
    });

    it('re-derives fasting from the items and drops codes no longer in the catalogue', () => {
      const base = labRequest();
      const dto = labRequest({
        items: [
          { ...base.items[0], id: 'a', code: 'FBS', short: 'FBS', label: 'FBS', specimen_mode: 'auto', specimen_code: 'plasma_fluoride' },
          { ...base.items[0], id: 'b', position: 2, code: 'OLD-TEST', label: 'Old test', short: 'Old' },
        ],
      });
      const { state, dropped } = fromRequest(dto, opts, ctx);
      expect(dropped).toEqual(['Old test']);
      expect(state.items.map((i) => i.code)).toEqual(['FBS']);
      expect(state).toMatchObject({ fasting: true, fastingHours: '8', fastingSource: 'FBS' });
    });
  });

  it('revalidate drops what left the catalogue and names it', () => {
    const s = form('FBC', 'MP');
    const fewer = labOptions({ items: LAB_ITEMS.filter((i) => i.code !== 'MP') });
    const { state, dropped } = revalidate(s, fewer);
    expect(dropped).toEqual(['Malaria MP']);
    expect(state.items.map((i) => i.code)).toEqual(['FBC']);
  });

  it('isDirty ignores UI-only choices', () => {
    const start = emptyForm(ctx);
    expect(isDirty({ ...start, tab: 'imaging', category: 'microbiology', site: 'blood', modality: 'ct' }, start)).toBe(false);
    expect(isDirty({ ...start, clientKey: 'other' }, start)).toBe(false);
    expect(isDirty(setText(start, 'question', 'Fever'), start)).toBe(true);
    expect(isDirty(addItem(start, cat('FBC')), start)).toBe(true);
    expect(isDirty({ ...start, priority: 'stat' }, start)).toBe(true);
  });

  it('searchCatalogue matches every term in label, name, short or synonyms, prefix matches first, at most 8', () => {
    const labs = LAB_ITEMS.filter((i) => i.kind === 'lab');
    expect(searchCatalogue(labs, 'malaria').map((i) => i.code)).toEqual(['MP']);
    expect(searchCatalogue(labs, 'blood sugar').map((i) => i.code)).toEqual(['RBS', 'FBS']);
    expect(searchCatalogue(labs, 'FB').map((i) => i.code)).toEqual(['FBC', 'FBS']);
    expect(searchCatalogue(labs, 'culture').map((i) => i.code)).toEqual(['MCS-BLOOD', 'MCS-URINE']);
    expect(searchCatalogue(labs, 'chest')).toEqual([]);
    expect(searchCatalogue(labs, '  ')).toEqual([]);
    expect(searchCatalogue([...labs, ...labs], 'b').length).toBeLessThanOrEqual(8);
  });
});
