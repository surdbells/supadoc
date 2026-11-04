import { dualTime, viewerTimeZone } from '@supadoc/data-access';
import { drLast, possessive } from './document-sharing';

/**
 * The doctor's own clock beside a time the patient sees in this device's zone
 * (U2, D10): only when their UTC offsets differ AT THAT INSTANT (EU and US
 * daylight-saving weeks differ), with the weekday when the doctor's date is a
 * different one. An older API without the doctor's `timezone` shows nothing.
 */

/** A doctor as the appointment payloads carry them. */
export interface DoctorZoneRef {
  readonly name?: string | null;
  readonly timezone?: string | null;
}

/** "9:00 AM CST" / "Thu 4:00 AM CST" — the doctor's time at `at`, or null (same offset, unknown zone, bad instant). */
export function doctorClock(
  at: string | number | Date | null | undefined,
  doctorTz: string | null | undefined,
  viewerTz: string = viewerTimeZone(),
): string | null {
  if (at === null || at === undefined || at === '' || !doctorTz) return null;
  return dualTime(at, viewerTz, doctorTz, 'time').secondary;
}

/** "Dr Ade's time" ("the doctor's time" without a name). */
export function doctorTimeWho(name: string | null | undefined): string {
  const short = drLast(name);
  return short ? `${possessive(short)} time` : "the doctor's time";
}

/** "9:00 AM CST Dr Ade's time" — the secondary label (shown after a "·"), or null when not needed. */
export function doctorTimeLabel(
  at: string | number | Date | null | undefined,
  doctor: DoctorZoneRef | null | undefined,
  viewerTz?: string,
): string | null {
  const clock = doctorClock(at, doctor?.timezone, viewerTz);
  return clock ? `${clock} ${doctorTimeWho(doctor?.name)}` : null;
}
