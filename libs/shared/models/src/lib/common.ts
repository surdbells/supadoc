/** Primitive aliases shared across the domain. */
export type ID = string;

/** ISO-8601 date-time string, e.g. `2026-07-18T09:30:00.000Z`. */
export type ISODateString = string;

export enum UserRole {
  Doctor = 'doctor',
  Patient = 'patient',
  Admin = 'admin',
  Staff = 'staff',
}

export enum Gender {
  Male = 'male',
  Female = 'female',
  Other = 'other',
  Unknown = 'unknown',
}

export enum AppointmentStatus {
  Requested = 'requested',
  Confirmed = 'confirmed',
  Cancelled = 'cancelled',
  Completed = 'completed',
  NoShow = 'no_show',
}
