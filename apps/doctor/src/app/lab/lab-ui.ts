import type { LabListGroup, LabPriority, LabRequestStatus } from '@supadoc/models';

/*
 * Laboratory & Diagnostics — the doctor app's shared labels and pure helpers
 * (chips, priority words, filter groups, dates). Every time shown is on the
 * doctor's clock (`DoctorClock`); calendar dates (`valid_until`, `lab_date`,
 * a correction's `sample_date`) are printed from their 'Y-m-d' parts, never
 * through `new Date('Y-m-d')` or a time-zone conversion.
 */

export interface LabChipMeta {
  readonly label: string;
  readonly cls: string;
}

/** Status chips: the text names every state (never colour alone). */
export const LAB_STATUS_META: Record<LabRequestStatus, LabChipMeta> = {
  awaiting_consent: { label: 'Awaiting Consent', cls: 'bg-warning/10 text-warning-ink' },
  booked: { label: 'Booked', cls: 'bg-cerulean/10 text-cerulean-dark' },
  in_lab: { label: 'In Lab', cls: 'bg-teal/10 text-teal-ink' },
  result_ready: { label: 'Result ready', cls: 'bg-sage/10 text-sage-ink' },
  declined: { label: 'Declined', cls: 'bg-cloud text-slate' },
  cancelled: { label: 'Cancelled', cls: 'bg-cloud text-slate' },
  expired: { label: 'Expired', cls: 'bg-cloud text-slate' },
};

// User decision 2026-11-04 (LD §7 #17): "Result ready · Abnormal" (§0.4).
export const LAB_ABNORMAL_META: LabChipMeta = { label: 'Result ready · Abnormal', cls: 'bg-alert/10 text-alert-ink' };

/** The chip for a request: a reviewed-abnormal result turns "Result ready" into "Result ready · Abnormal". */
export function labStatusMeta(r: { readonly status: LabRequestStatus; readonly abnormal: boolean }): LabChipMeta {
  if (r.status === 'result_ready' && r.abnormal) return LAB_ABNORMAL_META;
  return LAB_STATUS_META[r.status] ?? { label: 'Unknown', cls: 'bg-cloud text-slate' };
}

/** A cancelled request can hold reviewed results (T6c): it keeps "Cancelled" and says so underneath. */
export function showsAbnormalCaption(r: { readonly status: LabRequestStatus; readonly abnormal: boolean }): boolean {
  return r.status === 'cancelled' && r.abnormal;
}

export const LAB_PRIORITY_META: Record<LabPriority, LabChipMeta> = {
  stat: { label: 'STAT', cls: 'text-alert-ink' },
  urgent: { label: 'Urgent', cls: 'text-warning-ink' },
  routine: { label: 'Routine', cls: 'text-cerulean-dark' },
};

export const LAB_GROUPS: ReadonlyArray<{ readonly key: LabListGroup; readonly label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'awaiting_patient', label: 'Awaiting patient' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'result_ready', label: 'Result ready' },
];

export const STAT_EMERGENCY = 'If this is an emergency, advise the patient to go to the nearest emergency department.';
export const PRIORITY_HELPER = 'Target turnaround once the sample reaches the lab';
export const PREGNANCY_WARNING = 'Pregnant patient: check this study is safe in pregnancy before sending.';
export const CONTRAST_WARNING = 'Contrast allergy reported. Check before any contrast study.';

/** "{short} usually needs {n} hours of fasting." */
export function fastingWarning(short: string, hours: number): string {
  return `${short} usually needs ${hours} hours of fasting.`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar date of a 'Y-m-d' string, e.g. "4 Dec 2026" — no Date parsing, no zone conversion ('' when malformed). */
export function calendarDate(ymd: string | null | undefined): string {
  const m = YMD.exec((ymd ?? '').trim());
  if (!m) return '';
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${day} ${MONTHS[month - 1]} ${m[1]}`;
}

/** The day before a 'Y-m-d' calendar date (calendar arithmetic only). */
export function previousDay(ymd: string): string {
  const m = YMD.exec(ymd);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1));
  return d.toISOString().slice(0, 10);
}

/** What `labDayLabel` reads from the doctor's clock. */
export interface LabDayClock {
  ymd(at: string): string;
  today(): string;
  shortDate(at: string): string;
}

/** "Today" / "Yesterday" / "22 Oct 2026", on the doctor's clock. */
export function labDayLabel(iso: string | null | undefined, clock: LabDayClock): string {
  if (!iso) return '';
  const day = clock.ymd(iso);
  if (!day) return '';
  const today = clock.today();
  if (day === today) return 'Today';
  if (day === previousDay(today)) return 'Yesterday';
  return clock.shortDate(iso);
}

/** "55 years · Male"; parts omitted when null. */
export function ageSex(age: number | null | undefined, sex: string | null | undefined): string {
  const parts: string[] = [];
  if (typeof age === 'number' && Number.isFinite(age)) parts.push(`${age} year${age === 1 ? '' : 's'}`);
  const s = (sex ?? '').trim();
  if (s) parts.push(s);
  return parts.join(' · ');
}

/** "Dr. James Smith" — never "Dr. Dr. …" when the stored name already has the title. */
export function drName(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (!n) return 'Your doctor';
  return /^dr\.?\s/i.test(n) ? n : `Dr. ${n}`;
}

/** A patient's first name, for "{first name} hasn't shared…" ('the patient' when unknown). */
export function firstName(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  return n ? n.split(/\s+/)[0] : 'The patient';
}

/**
 * A request number cut after each hyphen ("GVM-", "REQ-", "20261105-", "00001"),
 * for a `<wbr>` after each part: browsers never break between a hyphen and a
 * digit, so a narrow screen otherwise splits the digits ("…-0 / 0001").
 */
export function numberParts(n: string | null | undefined): string[] {
  return (n ?? '').match(/[^-]*-|[^-]+$/g) ?? [];
}

/**
 * A specimen as it reads after another label: "Venous blood: serum" →
 * "Venous blood (serum)", "Venous blood: plasma (EDTA)" → "Venous blood
 * (plasma, EDTA)", so "Lipid profile: …" never shows two colons. Others as given.
 */
export function specimenText(label: string): string {
  const m = /^([^:]+):\s*(.+)$/.exec(label.trim());
  if (!m) return label;
  const inner = m[2].replace(/\s*\(([^()]*)\)$/, ', $1');
  return `${m[1].trim()} (${inner})`;
}

/** "1 request" / "3 requests". */
export function countLabel(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The HTTP status of either error shape (`ApiError.statusCode` / `HttpErrorResponse.status`), else null. */
export function httpStatusOf(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return null;
}
