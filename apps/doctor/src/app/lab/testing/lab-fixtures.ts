import type {
  LabCatalogueItem,
  LabOptionsDto,
  LabRequestContextDto,
  LabRequestDto,
  LabRequestSummaryDto,
} from '@supadoc/models';

/*
 * Test data for the lab specs (never imported by app code). A small slice of
 * the 2026-11.1 catalogue with the same shapes and flags as the API's.
 */

/** The value, or a failed test naming what was missing (specs use this, never non-null assertions). */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Missing: ${what}`);
  return value;
}

function item(over: Partial<LabCatalogueItem> & Pick<LabCatalogueItem, 'code' | 'label'>): LabCatalogueItem {
  return {
    kind: 'lab',
    category: 'single_test',
    modality: null,
    site: null,
    name: over.label,
    short: over.label,
    synonyms: [],
    common: false,
    default_specimen: 'serum',
    fasting_hours: null,
    default_preparation: null,
    contrast_possible: false,
    ionising: false,
    ...over,
  };
}

export const LAB_ITEMS: LabCatalogueItem[] = [
  item({ code: 'FBC', label: 'FBC - Full Blood Count', name: 'Full Blood Count', short: 'FBC', category: 'routine_panel', common: true, default_specimen: 'whole_blood_edta', synonyms: ['full blood count', 'cbc'] }),
  item({ code: 'LIPID', label: 'Lipid - Lipid Profile', name: 'Lipid Profile', short: 'Lipid profile', category: 'routine_panel', fasting_hours: 10, synonyms: ['cholesterol'] }),
  item({ code: 'MP', label: 'Malaria MP', common: true, default_specimen: 'whole_blood_edta', synonyms: ['malaria', 'malaria parasite'] }),
  item({ code: 'RBS', label: 'RBS', common: true, default_specimen: 'plasma_fluoride', synonyms: ['random blood sugar', 'glucose'] }),
  item({ code: 'FBS', label: 'FBS', fasting_hours: 8, default_specimen: 'plasma_fluoride', synonyms: ['fasting blood sugar', 'glucose'] }),
  item({ code: 'HIV', label: 'HIV screening', common: true, synonyms: ['hiv'] }),
  item({ code: 'HBSAG', label: 'HBsAg', common: true, synonyms: ['hepatitis b'] }),
  item({ code: 'WIDAL', label: 'Widal', common: true, synonyms: ['typhoid'] }),
  item({ code: 'UA', label: 'Urinalysis', common: true, default_specimen: 'urine_msu', synonyms: ['urine'] }),
  item({ code: 'GRAM-BLOOD', label: 'Gram stain - Blood', category: 'microbiology', site: 'blood', default_specimen: 'blood_culture', synonyms: ['gram'] }),
  item({ code: 'MCS-BLOOD', label: 'M/C/S - Blood', category: 'microbiology', site: 'blood', default_specimen: 'blood_culture', synonyms: ['culture'] }),
  item({ code: 'MCS-URINE', label: 'M/C/S - Urine', category: 'microbiology', site: 'urine', default_specimen: 'urine_msu', synonyms: ['culture'] }),
  item({ code: 'XR-CHEST', label: 'X-Ray - Chest', kind: 'imaging', category: 'imaging', modality: 'x_ray', default_specimen: null, default_preparation: 'none', ionising: true }),
  item({ code: 'US-PELVIS', label: 'Ultrasound - Pelvis', kind: 'imaging', category: 'imaging', modality: 'ultrasound', default_specimen: null, default_preparation: 'full_bladder' }),
  item({ code: 'CT-HEAD', label: 'CT - Head', kind: 'imaging', category: 'imaging', modality: 'ct', default_specimen: null, default_preparation: 'none', contrast_possible: true, ionising: true }),
  item({ code: 'MRI-KNEE', label: 'MRI - Knee', kind: 'imaging', category: 'imaging', modality: 'mri', default_specimen: null, default_preparation: 'none', contrast_possible: true }),
  item({ code: 'ECG12', label: 'ECG (12-lead)', kind: 'physiological', category: 'physiological', default_specimen: null }),
  item({ code: 'SPIRO', label: 'Spirometry', kind: 'physiological', category: 'physiological', default_specimen: null }),
];

export function labOptions(over: Partial<LabOptionsDto> = {}): LabOptionsDto {
  return {
    catalogue_version: '2026-11.1',
    priorities: [
      { value: 'routine', label: 'Routine', subtitle: 'Results in 24 - 48 hours' },
      { value: 'urgent', label: 'Urgent', subtitle: 'Same day' },
      { value: 'stat', label: 'STAT', subtitle: 'Under 1 hour' },
    ],
    purposes: [
      { value: 'diagnosis', label: 'Diagnosis' },
      { value: 'monitoring', label: 'Monitoring' },
      { value: 'screening', label: 'Screening' },
      { value: 'pre_operative', label: 'Pre-operative' },
    ],
    categories: [
      { value: 'routine_panel', label: 'Routine panels' },
      { value: 'single_test', label: 'Single tests' },
      { value: 'microbiology', label: 'Microbiology' },
    ],
    sites: [
      { value: 'urine', label: 'Urine', specimen: 'urine_msu' },
      { value: 'blood', label: 'Blood', specimen: 'blood_culture' },
    ],
    modalities: [
      { value: 'x_ray', label: 'X-Ray' },
      { value: 'ultrasound', label: 'Ultrasound' },
      { value: 'ct', label: 'CT' },
      { value: 'mri', label: 'MRI' },
      { value: 'other', label: 'Others' },
    ],
    specimens: [
      { value: 'serum', label: 'Venous blood: serum', manual: true },
      { value: 'plasma_fluoride', label: 'Venous blood: plasma (fluoride)', manual: true },
      { value: 'whole_blood_edta', label: 'Whole blood (EDTA)', manual: true },
      { value: 'urine_msu', label: 'Urine (mid-stream)', manual: true },
      { value: 'blood_culture', label: 'Blood culture bottles', manual: false },
    ],
    preparations: [
      { value: 'none', label: 'None', patient_text: null },
      { value: 'full_bladder', label: 'Full bladder', patient_text: 'Drink water.' },
      { value: 'fasting', label: 'Fasting', patient_text: "Don't eat." },
      { value: 'bowel_prep', label: 'Bowel prep', patient_text: 'Follow the prep.' },
    ],
    infection_alerts: [
      { value: 'hiv', label: 'HIV' },
      { value: 'hep_b', label: 'Hep B' },
      { value: 'hep_c', label: 'Hep C' },
      { value: 'tb', label: 'TB' },
    ],
    mobility: [
      { value: 'walking', label: 'Walking' },
      { value: 'chair', label: 'Chair' },
      { value: 'bed', label: 'Bed' },
      { value: 'portable', label: 'Portable' },
    ],
    items: LAB_ITEMS,
    limits: {
      max_items: 20,
      question_min: 3,
      question_max: 200,
      text_max: 500,
      fasting_hours: [1, 24],
      weeks_pregnant: [1, 42],
      comment_max: 1000,
      reason_max: 500,
    },
    has_signature: true,
    ...over,
  };
}

export function cat(code: string): LabCatalogueItem {
  const found = LAB_ITEMS.find((i) => i.code === code);
  if (!found) throw new Error(`No test item ${code}`);
  return found;
}

export function labContext(over: Partial<LabRequestContextDto> = {}, patient: Partial<LabRequestContextDto['patient']> = {}): LabRequestContextDto {
  return {
    patient: {
      id: 'p1',
      name: 'Chika Osuji',
      first_name: 'Chika',
      email: 'chikaosuji@gmail.com',
      age: 55,
      sex: 'Male',
      reference: 'P-1A2B3C4D',
      avatar_url: null,
      ...patient,
    },
    ask_pregnancy: false,
    prefill: { medication: 'Metformin 500 mg', allergies: 'Penicillin (severe)' },
    appointment: null,
    ...over,
  };
}

export function labSummary(over: Partial<LabRequestSummaryDto> = {}): LabRequestSummaryDto {
  return {
    id: 'lr1',
    number: 'GVM-REQ-20261104-00012',
    status: 'awaiting_consent',
    priority: 'routine',
    appointment_id: null,
    patient: { id: 'p1', name: 'Tunde Bakare', age: 55, sex: 'Male' },
    clinical_question: 'Chest pain, rule out ACS',
    tests_label: 'Troponin I, ECG (12-lead)',
    items_count: 2,
    counts: { lab: 1, imaging: 0, physiological: 1 },
    results_count: 0,
    unreviewed_count: 0,
    abnormal: false,
    sent_at: '2026-11-04T15:30:00Z',
    valid_until: '2026-12-04',
    expires_at: '2026-12-04T23:00:00Z',
    last_activity_at: '2026-11-04T15:30:00Z',
    ...over,
  };
}

export function labRequest(over: Partial<LabRequestDto> = {}): LabRequestDto {
  return {
    ...labSummary(),
    patient: { id: 'p1', name: 'Chika Osuji', age: 55, sex: 'Male' },
    clinical_question: 'Suspected iron-deficiency anaemia',
    tests_label: 'FBC, X-Ray - Chest',
    appointment_scheduled_at: null,
    purpose: 'diagnosis',
    history: 'Fatigue for 3 weeks',
    medication: 'Paracetamol',
    allergies: 'Penicillin',
    clinical: {
      fasting: true,
      fasting_hours: 8,
      pregnancy_asked: false,
      pregnant: null,
      weeks_pregnant: null,
      infection_alerts: ['tb', 'hiv'],
      transfusion_3m: true,
    },
    imaging_safety: { contrast_allergy: 'yes', mobility: 'chair', pregnant: 'na' },
    catalogue_version: '2026-11.1',
    items: [
      {
        id: 'i1', position: 1, code: 'FBC', kind: 'lab', category: 'routine_panel', modality: null, site: null,
        label: 'FBC - Full Blood Count', short: 'FBC', specimen_mode: 'manual', specimen_code: 'serum',
        specimen_label: 'Venous blood: serum', preparation_code: null, preparation_label: null, contrast_possible: false, ionising: false,
      },
      {
        id: 'i2', position: 2, code: 'XR-CHEST', kind: 'imaging', category: 'imaging', modality: 'x_ray', site: null,
        label: 'X-Ray - Chest', short: 'X-Ray - Chest', specimen_mode: null, specimen_code: null, specimen_label: null,
        preparation_code: 'full_bladder', preparation_label: 'Full bladder', contrast_possible: false, ionising: true,
      },
    ],
    prescriber: {
      id: 's1', name: 'Dr. James Smith', specialty: 'Cardiologist', qualifications: 'MBBS',
      registration_label: 'MDCN', registration_number: '12345',
    },
    patient_snapshot: { name: 'Chika Osuji', reference: 'P-1A2B3C4D', email: 'chikaosuji@gmail.com', date_of_birth: '4 Nov 1971', age: 55, sex: 'Male' },
    consent: null,
    lab_name: null,
    lab_date: null,
    declined_at: null,
    decline_reason: null,
    sample_at: null,
    result_ready_at: null,
    reviewed_at: null,
    cancelled_at: null,
    cancel_reason: null,
    expired_at: null,
    duplicated_from: null,
    results: [],
    timeline: [
      { event: 'sent', from_status: null, to_status: 'awaiting_consent', actor_role: 'doctor', actor_name: 'Dr. James Smith', at: '2026-11-04T15:30:00Z', sample_date: null },
    ],
    can: { cancel: true, review: false, duplicate: true },
    ...over,
  };
}
