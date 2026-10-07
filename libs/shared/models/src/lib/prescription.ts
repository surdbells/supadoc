/**
 * E-prescribing models (GVM-RX-01/02) — mirror the API's `Prescription`
 * serialisation (`toSummaryArray()` / `toArray()`), the RxNorm `Drug`, the
 * doctor's side panel and the pharmacist check.
 */

/** Effective status: an active prescription reads `expired` from the day after valid-until. */
export type PrescriptionStatus = 'draft' | 'active' | 'expired' | 'cancelled';

export type PregnancyStatus =
  | 'no'
  | 'pregnant'
  | 'breastfeeding'
  | 'unknown'
  | 'not_applicable';

export type FollowUpMode = 'video' | 'in_person';

export type ReadingKey =
  | 'temperature'
  | 'heart_rate'
  | 'blood_pressure'
  | 'respiratory_rate'
  | 'oxygen_saturation'
  | 'blood_sugar'
  | 'weight'
  | 'height'
  | 'bmi'
  | 'pain_score';

export type ReadingSource = 'patient_device' | 'video' | 'clinic' | 'lab';

/** RxNorm term type: generic (SCD), branded (SBD), generic/branded pack (GPCK/BPCK). */
export type DrugTermType = 'SCD' | 'SBD' | 'GPCK' | 'BPCK';

/** A prescribable product from the RxNorm catalogue (GET /api/doctor/drugs). */
export interface DrugDto {
  rxcui: string;
  tty: DrugTermType;
  /** Display name (RxNorm prescribable name). */
  name: string;
  /** Generic (non-brand) name. */
  generic_name: string;
  brand: string | null;
  branded: boolean;
  dose_form: string | null;
  /** Suggested route (Oral, Injection, Eye…), derived from the dose form. */
  route: string | null;
}

/** Health readings on the form; every box is optional. Values are strings as typed. */
export type PrescriptionReadings = Partial<Record<ReadingKey, string>> & {
  source?: ReadingSource;
  /** ISO date-time the readings were taken. */
  taken_at?: string;
};

/** One medicine row as stored (catalogue fields are snapshotted server-side). */
export interface PrescriptionItem {
  rxcui: string | null;
  name: string;
  generic_name: string;
  brand: string | null;
  branded: boolean;
  dose_form: string | null;
  /** How much to take, e.g. "1 tablet". */
  dose: string;
  route: string;
  /** How often, e.g. "Every 8 hours". */
  frequency: string;
  /** For how long, e.g. "5 days". */
  duration: string;
  /** Quantity to give, e.g. "15 tablets". */
  quantity: string;
  repeats: number;
  /** The pharmacy must give exactly this brand. */
  no_substitute: boolean;
  instructions: string;
}

/** One medicine row as sent by the composer — the name comes from `rxcui`. */
export interface PrescriptionItemInput {
  rxcui: string | null;
  dose: string;
  route: string;
  frequency: string;
  duration: string;
  quantity: string;
  repeats: number;
  no_substitute: boolean;
  instructions: string;
}

/** Prescriber details as printed (frozen at send). */
export interface PrescriberDetails {
  id?: string;
  name?: string;
  specialty?: string;
  qualifications?: string;
  mdcn_number?: string;
}

/** Patient details as printed (frozen at send). */
export interface PrescriptionPatientDetails {
  name?: string;
  date_of_birth?: string;
  dob_iso?: string;
  sex?: string;
  reference?: string;
  age?: string;
}

/** List row — never names medicines or the reason. */
export interface PrescriptionSummaryDto {
  id: string;
  /** GVM-RX-YYYYMMDD-NNNNN */
  number: string;
  status: PrescriptionStatus;
  appointment_id: string | null;
  patient_id: string;
  /** Prescriber's name. */
  prescriber: string | null;
  patient_name: string | null;
  items_count: number;
  /** YYYY-MM-DD */
  valid_until: string | null;
  allows_repeats: boolean;
  sent_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

/** The full prescription (prescriber, patient, authorised staff). */
export interface PrescriptionDto extends PrescriptionSummaryDto {
  readings: PrescriptionReadings;
  reason: string | null;
  icd_code: string | null;
  current_medications: string | null;
  pregnancy_status: PregnancyStatus | null;
  items: PrescriptionItem[];
  advice: string | null;
  /** YYYY-MM-DD */
  follow_up_date: string | null;
  follow_up_mode: FollowUpMode | null;
  tests_referrals: string | null;
  prescriber_details: PrescriberDetails;
  patient_details: PrescriptionPatientDetails;
  signature_mode: 'saved' | 'drawn' | null;
  cancel_reason: string | null;
  replaces_id: string | null;
  replaced_by_id: string | null;
  /** 1, or 2 when there are more than five medicines. */
  page_count: number;
  /** Legacy fields. */
  notes: string | null;
  signed_at: string | null;
  author: string | null;
  specialist_id: string | null;
}

/** The editable form (all optional — a draft may be partial). */
export interface PrescriptionFormInput {
  readings?: PrescriptionReadings;
  reason?: string | null;
  icd_code?: string | null;
  current_medications?: string | null;
  pregnancy_status?: PregnancyStatus | null;
  items?: PrescriptionItemInput[];
  advice?: string | null;
  follow_up_date?: string | null;
  follow_up_mode?: FollowUpMode | null;
  tests_referrals?: string | null;
  valid_until?: string | null;
  allows_repeats?: boolean;
}

/** POST /api/doctor/prescriptions — `appointment_id` (consultation) or `patient_id` (standalone). */
export interface CreatePrescriptionInput extends PrescriptionFormInput {
  appointment_id?: string;
  patient_id?: string;
}

/** POST /api/doctor/prescriptions/{id}/send */
export interface SendPrescriptionInput {
  /** Final edits saved before sending. */
  form?: PrescriptionFormInput;
  /** The pre-send checklist — all three must be true. */
  confirm: { allergies: boolean; doses: boolean; patient: boolean };
  signature: {
    mode: 'saved' | 'drawn';
    /** `data:image/png;base64,…` when drawn. */
    image?: string;
    /** Also save the drawn signature to the profile. */
    save?: boolean;
  };
}

export interface CancelPrescriptionResult {
  cancelled: PrescriptionDto;
  replacement: PrescriptionDto | null;
}

/**
 * A short-lived signed link to the PDF. `url` is API-relative
 * (`/api/public/prescriptions/file?token=…`) — resolve it against the API base.
 */
export interface PrescriptionLinkDto {
  url: string;
  expires_at: string;
  filename: string;
}

export interface PrescriptionReadingField {
  key: ReadingKey;
  label: string;
  unit: string;
  min: number | null;
  max: number | null;
}

/** GET /api/doctor/prescriptions/options */
export interface PrescriptionOptionsDto {
  valid_days: number;
  /** YYYY-MM-DD */
  default_valid_until: string;
  max_items: number;
  rows_per_page: number;
  max_repeats: number;
  limits: Record<
    'reason' | 'current_medications' | 'advice' | 'tests_referrals' | 'instructions',
    number
  >;
  routes: string[];
  readings: PrescriptionReadingField[];
  reading_sources: Record<ReadingSource, string>;
  pregnancy: Record<PregnancyStatus, string>;
  follow_up_modes: Record<FollowUpMode, string>;
  has_signature: boolean;
  mdcn_number: string | null;
}

export type AllergySeverity =
  | 'life-threatening'
  | 'severe'
  | 'moderate'
  | 'mild'
  | 'unknown';

/** GET /api/doctor/patients/{id}/clinical-summary — the read-only side panel. */
export interface ClinicalSummaryDto {
  patient: {
    id: string;
    name: string;
    gender: string | null;
    date_of_birth: string | null;
    age: number | null;
  };
  allergies_recorded: boolean;
  /** Most serious first. */
  allergies: { substance: string; reaction: string; severity: AllergySeverity }[];
  /** Female aged 12–55: remind the doctor to answer the pregnancy question. */
  ask_pregnancy: boolean;
  vitals: {
    key: ReadingKey;
    label: string;
    value: string;
    unit: string;
    taken_at: string | null;
    source: string | null;
    /** Older than 7 days — "May be out of date". */
    stale: boolean;
  }[];
  /** Grouped by what they are for. */
  medicines: {
    for: string;
    items: { name: string; amount: string; frequency: string; herbal: boolean }[];
  }[];
  conditions: string[];
}

/** GET/POST/DELETE /api/doctor/signature */
export interface DoctorSignatureDto {
  has_signature: boolean;
  /** `data:image/png;base64,…` or null. */
  image: string | null;
}

/** GET/PATCH /api/settings/prescriptions (back office). */
export interface PrescriptionSettingsDto {
  valid_days: number;
  reminder_days: number;
  check_max_attempts: number;
  check_lock_minutes: number;
  link_minutes: number;
}

/** POST /api/public/prescriptions/check — always 200 with one of these. */
export type PrescriptionCheckResult =
  | {
      result: 'match';
      number: string;
      status: Exclude<PrescriptionStatus, 'draft'>;
      sent_at: string | null;
      valid_until: string | null;
      doctor: string;
      mdcn_number: string | null;
    }
  | { result: 'no_match'; attempts_left: number }
  | { result: 'locked'; retry_at: string };
