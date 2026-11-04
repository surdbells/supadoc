import { formatInZone, isValidTimeZone, offsetsDiffer, timeLabel, viewerTimeZone, zoneAbbr } from '@supadoc/data-access';
import { CLINIC_TZ } from '../core/format';

/** Fixed English names (never locale text), as the shared zone helpers use. */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** "Wednesday 14 October" — the date on `tz`'s calendar. */
function longDate(at: Date, tz: string): string {
  const [y, m, d] = formatInZone(at, tz, 'ymd').split('-').map(Number);
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

/**
 * The interview time for the applicant. In clinic time when their device
 * reads the same as WAT: "Wednesday 14 October, 10:00 WAT · video call".
 * Otherwise their own time leads, then the clinic's: "Wednesday 14 October,
 * 4:00 AM CDT your time · 10:00 WAT VideoMed time · video call" (with the
 * clinic's day when the dates differ: "… · Wed 14 Oct, 10:00 WAT VideoMed
 * time · …").
 */
export function interviewLabel(startsAt: string, viewerTz: string = viewerTimeZone()): string {
  const at = new Date(startsAt);
  if (Number.isNaN(at.getTime())) return '';
  const clinic = `${formatInZone(at, CLINIC_TZ, 'hm')} ${zoneAbbr(CLINIC_TZ, at)}`;
  if (!isValidTimeZone(viewerTz) || !offsetsDiffer(at, viewerTz, CLINIC_TZ)) {
    return `${longDate(at, CLINIC_TZ)}, ${clinic} · video call`;
  }
  const sameDate = formatInZone(at, viewerTz, 'ymd') === formatInZone(at, CLINIC_TZ, 'ymd');
  const clinicDay = sameDate ? '' : `${formatInZone(at, CLINIC_TZ, 'date').replace(/ \d+$/, '')}, `;
  return `${longDate(at, viewerTz)}, ${timeLabel(at, viewerTz)} your time · ${clinicDay}${clinic} VideoMed time · video call`;
}
