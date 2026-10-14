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
}

export interface VitalsReminderDto {
  due: boolean;
  reason: 'never' | 'stale' | null;
  last_taken_at: string | null;
  days_old: number | null;
  stale_after_days: number;
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
