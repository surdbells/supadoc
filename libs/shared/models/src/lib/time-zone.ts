/**
 * Time zones (doctors and patients each have an IANA zone on their profile).
 *
 * The API always sends the EFFECTIVE zone (`timezone`): the saved one, else the
 * clinic's (Africa/Lagos). `timezone_source` says whether it was ever set:
 * `auto` (detected from a browser), `manual` (chosen), null (never set — the
 * clinic zone is in use). Helpers live in `@supadoc/data-access` (time-zone.ts).
 */

/** How a saved zone was set: detected from a browser, or chosen by hand. */
export type TimeZoneSource = 'auto' | 'manual';

/**
 * Body for PUT /api/doctor/timezone and PUT /api/portal/me/timezone.
 * `auto` only writes while no zone was ever set (and only a detectable zone);
 * `manual` always writes. `shift_slots` (doctor, `manual` only) also re-times
 * the doctor's future unbooked open times and blocks to the same wall clock.
 */
export interface SetTimeZoneInput {
  timezone: string;
  source: TimeZoneSource;
  shift_slots?: boolean;
}

/** PUT …/timezone answer: the effective zone now, and whether this request changed it. */
export interface TimeZoneStateDto {
  timezone: string;
  timezone_source: TimeZoneSource | null;
  changed: boolean;
}

/** PUT /api/doctor/timezone answer; `shifted` is null unless `shift_slots` ran. */
export interface DoctorTimeZoneResultDto extends TimeZoneStateDto {
  shifted: { moved: number; skipped: number } | null;
}

/**
 * `errors` of a 409 from the doctor availability endpoints when the request's
 * `tz` is no longer the doctor's profile zone (changed in another window):
 * re-apply `timezone`, reload, and tell the doctor.
 */
export interface TimeZoneChangedError {
  code: 'timezone_changed';
  timezone: string;
}
