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
 * attention") readings — never for weight/BMI or pain.
 */
export interface VitalFlagDto {
  level: VitalFlagLevel;
  label: string;
  advice: 'Seek medical attention' | 'Seek urgent medical attention' | null;
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
  max: number | null;
  step: number | null;
  /** Blood pressure only: the bounds of each number. */
  systolic?: { min: number; max: number };
  diastolic?: { min: number; max: number };
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
