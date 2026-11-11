/**
 * Patient vitals — mirror the API's `VitalsService` (GET/POST
 * /api/portal/me/vitals, /me/vitals/history) and the `patient.vitals` list on
 * the doctor's join payload. The catalogue (`ReadingKey`) is shared with the
 * prescription form.
 */
import type { ReadingKey } from './prescription';

/** Where a reading came from; patients choose `self_reported` or `patient_device`. */
export type VitalSource =
  | 'self_reported'
  | 'patient_device'
  | 'video'
  | 'clinic'
  | 'lab';

export type VitalRecordedBy = 'patient' | 'doctor';

/** Where a reading sits against typical adult resting ranges (the API's `VitalsFlags`). */
export type VitalFlagLevel = 'normal' | 'low' | 'elevated' | 'high' | 'critical';

/**
 * A reading's flag, worked out on the server so every screen says the same
 * thing. `label` is "Normal" | "Low" | "Elevated" | "High" | "Very high" |
 * "Very low" (pain: "None" | "Mild" | "Moderate" | "Severe"). `advice` is set
 * for high ("Seek medical attention") and critical ("Seek urgent medical
 * attention") readings — never for pain, nor for weight/BMI unless the
 * reading is above its usual range.
 */
export interface VitalFlagDto {
  level: VitalFlagLevel;
  label: string;
  advice: 'Seek medical attention' | 'Seek urgent medical attention' | null;
  /**
   * The reading is above its usual entry range (it was still saved): screens
   * ask to check it. Always "Very high" + urgent advice. Absent on older APIs —
   * treat as false.
   */
  out_of_range?: boolean;
  /**
   * The usual maximum, e.g. "45" or (blood pressure) "260/160"; set only when
   * `out_of_range`, and null even then for a weight flagged by the BMI it gives.
   */
  usual_max?: string | null;
}

/** The newest reading of one type. */
export interface VitalReadingDto {
  key: ReadingKey;
  label: string;
  /** A number ("37.8") or, for blood pressure, "120/80". */
  value: string;
  unit: string;
  taken_at: string | null;
  source: VitalSource | null;
  source_label: string | null;
  recorded_by: VitalRecordedBy;
  /** Older than 7 days — "may be out of date". */
  stale: boolean;
  /**
   * Null for height, for a weight or BMI with no height on file, and for a
   * latest BMI older than the latest weight or height. Optional so a
   * payload from an API that predates flags still type-checks — treat
   * `undefined` as "no flag".
   */
  flag?: VitalFlagDto | null;
}

/** One row of GET /api/portal/me/vitals/history (newest first). */
export interface VitalHistoryDto extends VitalReadingDto {
  id: string;
  taken_at: string;
  created_at: string;
}

/** A box on the "Update vitals" form. */
export interface VitalFieldDto {
  key: ReadingKey;
  label: string;
  unit: string;
  min: number | null;
  /** The usual entry maximum (above it: saved, with a warning, when `accepts_above`). */
  max: number | null;
  step: number | null;
  /** The most the API accepts; null for blood pressure (see `systolic` / `diastolic`). Absent on older APIs: use `max`. */
  max_hard?: number | null;
  /** False for oxygen and pain: `max` is also the ceiling. Absent on older APIs: false. */
  accepts_above?: boolean;
  /** Blood pressure only: the bounds of each number. */
  systolic?: { min: number; max: number; max_hard?: number };
  diastolic?: { min: number; max: number; max_hard?: number };
  /** BMI: worked out from weight and height, never typed. */
  derived?: boolean;
  /** The typical adult band the flags use, e.g. "36.0–37.5" (null: none, e.g. weight, height). */
  normal_range?: string | null;
}

/**
 * Why to nudge the patient, most pressing first: `never` (no readings yet),
 * `upcoming` (a consultation starts within 48 hours and nothing was taken in
 * the 48 hours before it — `appointment` says which), `stale` (newest reading
 * older than `stale_after_days`).
 */
export type VitalsReminderReason = 'never' | 'upcoming' | 'stale';

export interface VitalsReminderDto {
  due: boolean;
  reason: VitalsReminderReason | null;
  last_taken_at: string | null;
  days_old: number | null;
  stale_after_days: number;
  /** Set only when `reason` is `upcoming`. */
  appointment?: { id: string; scheduled_at: string } | null;
}

/** GET /api/portal/me/vitals (also the body POST returns). */
export interface MyVitalsDto {
  latest: VitalReadingDto[];
  fields: VitalFieldDto[];
  sources: Record<VitalSource, string>;
  patient_sources: VitalSource[];
  reminder: VitalsReminderDto;
}

/** POST /api/portal/me/vitals */
export interface RecordVitalsInput {
  readings: Partial<Record<ReadingKey, string>>;
  /** ISO 8601; defaults to now on the server and may not be in the future. */
  taken_at?: string;
  source?: 'self_reported' | 'patient_device';
}

/**
 * A number as the API stores a reading: one decimal place (`VitalsForm::number`,
 * PHP's half-up rounding). Compare this — not the raw typed number — with a
 * reading's usual maximum, so 45.04 °C (stored "45") isn't warned about as
 * above the usual range when the saved reading won't be.
 */
export function storedReadingValue(n: number): number {
  // toPrecision(15) undoes binary noise first (45.05 × 10 = 450.49999…), as PHP's pre-rounding does.
  return Math.round(Number((n * 10).toPrecision(15))) / 10;
}
