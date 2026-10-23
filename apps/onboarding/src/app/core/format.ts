import { ymdInZone } from '@supadoc/data-access';
import { countryForNumber, WORLD_COUNTRIES } from '@supadoc/ui';

/** The clinic's zone: dates on the application are judged on the Lagos calendar. */
export const CLINIC_TZ = 'Africa/Lagos';

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
];

interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** 'YYYY-MM-DD' → parts, or null for anything else (impossible days included). */
export function parseYmd(value: unknown): Ymd | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d };
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function toYmd(p: Ymd): string {
  return `${String(p.y).padStart(4, '0')}-${pad(p.m)}-${pad(p.d)}`;
}

/** Today on the clinic calendar (Lagos), 'YYYY-MM-DD'. */
export function clinicToday(now: Date = new Date()): string {
  return ymdInZone(now, CLINIC_TZ);
}

/** `ymd` shifted by whole days. */
export function addDays(ymd: string, days: number): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return toYmd({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
}

/** `ymd` minus whole years (29 February → 28 February). */
export function minusYears(ymd: string, years: number): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  const y = p.y - years;
  const last = new Date(Date.UTC(y, p.m, 0)).getUTCDate();
  return toYmd({ y, m: p.m, d: Math.min(p.d, last) });
}

/**
 * The earliest acceptable Certificate of Good Standing date: 6 calendar months
 * before `today`, clamped to the month's end (31 August → 28/29 February).
 */
export function goodStandingMinDate(today: string): string {
  const p = parseYmd(today);
  if (!p) return today;
  let y = p.y;
  let m = p.m - 6;
  while (m < 1) {
    m += 12;
    y--;
  }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return toYmd({ y, m, d: Math.min(p.d, last) });
}

/** "21 April 2026" (no leading zero on the day). */
export function formatDayMonthYear(ymd: string | null | undefined): string {
  const p = parseYmd(ymd);
  return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : '';
}

/** "12 Mar 1985". */
export function formatDateLong(ymd: string | null | undefined): string {
  const p = parseYmd(ymd);
  return p ? `${p.d} ${MONTHS[p.m - 1].slice(0, 3)} ${p.y}` : '';
}

/** "3 KB", "1.2 MB", "512 B". */
export function formatBytes(bytes: number | null | undefined): string {
  const n = Math.max(0, Math.round(bytes ?? 0));
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Number(mb.toFixed(1))} MB`;
}

/** "cle***@gmail.com": the first 3 characters of the local part (fewer if shorter). */
export function maskEmail(email: string | null | undefined): string {
  const e = (email ?? '').trim();
  const at = e.lastIndexOf('@');
  if (at <= 0) return '';
  const local = e.slice(0, at);
  return `${local.slice(0, Math.min(3, local.length))}***@${e.slice(at + 1)}`;
}

/** Splits an E.164 number into its calling code (without +) and national digits. */
function splitE164(phone: string): { cc: string; national: string } | null {
  const raw = (phone ?? '').replace(/[^\d+]/g, '');
  if (!raw.startsWith('+')) return null;
  const country = countryForNumber(raw, WORLD_COUNTRIES);
  if (!country) return null;
  return { cc: country.dialCode.slice(1), national: raw.slice(country.dialCode.length) };
}

/** "0802*****56" for Nigeria, "+44 77*****23" elsewhere. */
export function maskPhone(phone: string | null | undefined): string {
  const parts = splitE164(phone ?? '');
  if (!parts || parts.national.length < 4) return '';
  const { cc, national } = parts;
  const tail = national.slice(-2);
  if (cc === '234') return `0${national.slice(0, 3)}*****${tail}`;
  return `+${cc} ${national.slice(0, 2)}*****${tail}`;
}

/** "+234 803 123 4567" for Nigeria; "+{cc} {rest}" elsewhere. */
export function formatPhone(phone: string | null | undefined): string {
  const value = (phone ?? '').trim();
  const parts = splitE164(value);
  if (!parts) return value;
  const { cc, national } = parts;
  if (cc === '234' && national.length === 10) {
    return `+234 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
  }
  return `+${cc} ${national}`;
}
