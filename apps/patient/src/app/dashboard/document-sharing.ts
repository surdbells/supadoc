/**
 * Patient document sharing — the pure helpers behind every sharing surface
 * (Medical Documents, Manage sharing, the share / extend / approve dialogs, the
 * upload "Who can see these files?" step, booking step 5, appointment details
 * and the in-call panel).
 *
 * Rules these helpers keep:
 *  - Dates: only the server's `*_label_at` instants are formatted (the
 *    exclusive end of an `until` share minus one second), in the viewer's zone:
 *    "30 Oct 2026", plus ", 4:30 PM" unless the label is 23:59 or midnight.
 *  - Everything is rendered from what the API answered, never from what was
 *    asked for.
 *  - Copy never names a document type or anything medical beyond the title the
 *    patient gave their own file.
 */
import { apiErrorCode, todayLocal } from '@supadoc/data-access';
import type {
  AfterDuration,
  BookingShareDuration,
  CreateDocumentShareInput,
  DoctorAccessSummaryDto,
  DocumentAccessEventDto,
  DocumentAccessRequestDto,
  DocumentAccessRequestStatus,
  DocumentGrantDto,
  DocumentShareDuration,
  DocumentShareResultDto,
  DocumentShareScope,
  DocumentShareSurface,
  DocumentSharedWithDto,
  SharingAppointmentRefDto,
  SharingDoctorDto,
  UploadedDocumentDto,
  UploadShareOptions,
} from '@supadoc/models';
import { doctorTitle } from '../call/call-helpers';

// ---------------------------------------------------------------------------
// Constants and small utilities
// ---------------------------------------------------------------------------

/** Every sharing surface says this (and offers no actions) on 503 `sharing_unavailable`. */
export const SHARING_UNAVAILABLE = 'Sharing is unavailable right now. Your documents stay private.';

/** The fixed reassurance under every share review. */
export const SHARE_NOTE =
  "Doctors only see what you share. You can change or stop sharing at any time. Copies a doctor has already downloaded aren't removed.";

/** At most this many doctors per share. */
export const MAX_SHARE_DOCTORS = 5;
/** At most this many documents per selected share. */
export const MAX_SHARE_DOCUMENTS = 200;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The server refuses an end sooner than this. */
const MIN_LEAD_MS = HOUR;

/** The API said sharing is switched off (503 `sharing_unavailable`). */
export function isSharingUnavailable(err: unknown): boolean {
  return apiErrorCode(err) === 'sharing_unavailable';
}

/** "Dr Ade" — a doctor's display name (adds "Dr" unless it is already a title). */
export function drName(name: string | null | undefined): string {
  return doctorTitle(name);
}

/** "Dr Ade's" */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** Initials for an avatar chip: "Dr Bayo Ade" → "BA". */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '')
    .replace(/^(dr|prof)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean);
  const letters = (words[0]?.[0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : '');
  return letters.toUpperCase() || '?';
}

/** "1 document" / "3 documents". */
export function countNoun(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

/** First letter upper-cased (sentences that start with "your doctor"). */
export function cap(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** A fresh idempotency / batch key. */
export function newKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // fall through
  }
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}

// ---------------------------------------------------------------------------
// Dialog themes (portal light/dark vs the call cockpit)
// ---------------------------------------------------------------------------

export type SharingTheme = 'light' | 'call';

/**
 * Class sets for the sharing dialogs. `light` uses only classes the patient
 * portal's dark mode already overrides (AA on the dark surfaces); `call` is
 * the cockpit's dark palette (remapped by the cockpit's own light theme).
 * The call body carries `sd-share`: in a LIGHT cockpit, styles.css turns its
 * bright accents (warning, sky links, success, alert) into their ink tones,
 * which theme.css leaves bright (made for the dark cockpit).
 */
export interface SharingClasses {
  readonly body: string;
  readonly heading: string;
  readonly text: string;
  readonly muted: string;
  readonly divider: string;
  readonly box: string;
  readonly on: string;
  readonly off: string;
  readonly primary: string;
  readonly secondary: string;
  readonly danger: string;
  readonly link: string;
  readonly note: string;
  readonly warn: string;
  readonly error: string;
  /** Inline validation text. */
  readonly errText: string;
  readonly field: string;
  readonly iconBtn: string;
  readonly accent: string;
}

export const SHARING_CLASSES: Record<SharingTheme, SharingClasses> = {
  light: {
    body: '',
    heading: 'text-ink',
    text: 'text-ink',
    muted: 'text-slate',
    divider: 'border-cloud',
    box: 'border-cloud bg-white',
    on: 'border-cerulean bg-frost/30',
    off: 'border-cloud hover:border-cerulean/40',
    primary: 'bg-cerulean text-white hover:bg-ocean',
    secondary: 'border border-cloud text-slate hover:bg-glacier',
    // alert-ink: AA on white and on the alert tint (#ff8a80 on dark, styles.css).
    danger: 'border border-alert text-alert-ink hover:bg-alert/5',
    link: 'text-cerulean hover:text-ocean',
    note: 'bg-glacier text-slate',
    warn: 'bg-warning/15 text-warning-ink',
    error: 'bg-alert/10 text-alert-ink',
    errText: 'text-alert-ink',
    field: 'border-cloud bg-white text-ink focus:border-cerulean',
    iconBtn: 'text-slate hover:text-ink',
    accent: 'text-cerulean',
  },
  call: {
    body: 'sd-share bg-abyss text-white',
    heading: 'text-white',
    text: 'text-white/85',
    muted: 'text-white/60',
    divider: 'border-white/10',
    box: 'border-white/15 bg-white/[0.04]',
    on: 'border-sky bg-white/10',
    off: 'border-white/15 hover:border-white/30',
    primary: 'bg-cerulean text-white hover:bg-ocean',
    secondary: 'border border-white/15 text-white/85 hover:bg-white/10',
    danger: 'border border-alert/60 text-alert hover:bg-alert/10',
    link: 'text-sky hover:text-white',
    note: 'bg-white/[0.06] text-white/75',
    warn: 'bg-warning/15 text-warning',
    error: 'bg-alert/15 text-alert',
    errText: 'text-alert',
    field: 'border-white/15 bg-white/5 text-white focus:border-sky',
    iconBtn: 'text-white/60 hover:bg-white/10 hover:text-white',
    accent: 'text-frost',
  },
};

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function toMs(iso: string | null | undefined): number {
  if (!iso) return NaN;
  return Date.parse(iso);
}

/** Wall-clock hour and minute of an instant in a zone (the viewer's by default). */
function wallClock(d: Date, tz?: string): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(d);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
    return { hour: get('hour') % 24, minute: get('minute') };
  } catch {
    return { hour: d.getHours(), minute: d.getMinutes() };
  }
}

function dateOnly(d: Date, tz?: string, withYear = true): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      day: 'numeric',
      month: 'short',
      ...(withYear ? { year: 'numeric' } : {}),
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      ...(withYear ? { year: 'numeric' } : {}),
    }).format(d);
  }
}

function timeOnly(d: Date, tz?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(d);
  }
}

/**
 * A server `*_label_at` instant for display: "30 Oct 2026", or
 * "28 Oct 2026, 4:30 PM" when the time matters (not 23:59, not midnight).
 * '' for a missing or invalid value.
 */
export function labelAt(iso: string | null | undefined, tz?: string): string {
  const ms = toMs(iso);
  if (isNaN(ms)) return '';
  const d = new Date(ms);
  const { hour, minute } = wallClock(d, tz);
  const date = dateOnly(d, tz);
  if ((hour === 23 && minute === 59) || (hour === 0 && minute === 0)) return date;
  return `${date}, ${timeOnly(d, tz)}`;
}

/** "Until 30 Oct 2026" / "No end date" ('' when there is neither). */
export function untilLabel(untilLabelAt: string | null | undefined, indefinite: boolean, tz?: string): string {
  if (indefinite) return 'No end date';
  const label = labelAt(untilLabelAt, tz);
  return label ? `Until ${label}` : '';
}

/** "until 30 Oct 2026" / "with no end date" — the tail of a sentence. */
export function untilPhrase(untilLabelAt: string | null | undefined, indefinite: boolean, tz?: string): string {
  if (indefinite) return 'with no end date';
  const label = labelAt(untilLabelAt, tz);
  return label ? `until ${label}` : '';
}

/** A plain date, e.g. "12 Oct 2026" ('' when invalid). */
export function dateLabel(iso: string | null | undefined, tz?: string): string {
  const ms = toMs(iso);
  return isNaN(ms) ? '' : dateOnly(new Date(ms), tz);
}

/** A date and time, e.g. "12 Oct 2026, 4:30 PM" ('' when invalid). */
export function dateTimeLabel(iso: string | null | undefined, tz?: string): string {
  const ms = toMs(iso);
  if (isNaN(ms)) return '';
  const d = new Date(ms);
  return `${dateOnly(d, tz)}, ${timeOnly(d, tz)}`;
}

/** A consultation's day for "your 28 Oct consultation". */
export function consultationDay(iso: string | null | undefined, tz?: string): string {
  const ms = toMs(iso);
  return isNaN(ms) ? '' : dateOnly(new Date(ms), tz, false);
}

/** Minutes a zone is ahead of UTC at an instant (+60 for Africa/Lagos). */
function zoneOffsetMinutes(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - ms) / 60_000);
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + n);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * "Until a date": the exclusive end the API wants — the start of the day
 * after the chosen one in the viewer's zone, as ISO with its offset.
 * `('2026-10-30', 'Africa/Lagos')` → `'2026-10-31T00:00:00+01:00'`.
 */
export function untilDateToExpiresAt(ymd: string, tz?: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const next = addDays(ymd, 1);
  const [y, m, d] = next.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let offset: number;
  try {
    offset = zoneOffsetMinutes(guess, zone);
    const second = zoneOffsetMinutes(guess - offset * 60_000, zone);
    if (second !== offset) offset = second;
  } catch {
    offset = -new Date(guess).getTimezoneOffset();
  }
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${next}T00:00:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The date picker's bounds: tomorrow … today + 365 (viewer's calendar). */
export function untilDateBounds(): { min: string; max: string } {
  return { min: todayLocal(1), max: todayLocal(365) };
}

/** Why an "Until a date" choice can't be used ('' when it can). */
export function untilDateError(ymd: string, bounds = untilDateBounds()): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(ymd) && ymd >= bounds.min && ymd <= bounds.max) return '';
  const max = dateOnly(new Date(`${bounds.max}T12:00:00`));
  return `Choose a date between tomorrow and ${max}.`;
}

/** 'YYYY-MM-DD' of an instant in the viewer's zone (for prefilling a date input). */
export function ymdOf(iso: string | null | undefined, tz?: string): string {
  const ms = toMs(iso);
  if (isNaN(ms)) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Durations ("For how long?")
// ---------------------------------------------------------------------------

export const AFTER_DURATIONS: readonly AfterDuration[] = ['after_24h', 'after_7d', 'after_30d'];

export function isAfterDuration(d: DocumentShareDuration | null | undefined): d is AfterDuration {
  return d === 'after_24h' || d === 'after_7d' || d === 'after_30d';
}

/** One "For how long?" chip. */
export interface DurationChoice {
  readonly value: DocumentShareDuration;
  readonly label: string;
  /** A line under the chip ('' for none). */
  readonly hint: string;
}

const RELATIVE_MS: Partial<Record<DocumentShareDuration, number>> = {
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
};

/**
 * The chips, in order: the appointment's non-null `after_options` (labelled
 * with their real end; an end within the hour is hidden too), then 24 hours,
 * 7 days, 30 days, Until a date and No end date.
 */
export function durationChoices(
  appointment: SharingAppointmentRefDto | null | undefined,
  now: number = Date.now(),
  tz?: string,
): DurationChoice[] {
  const out: DurationChoice[] = [];
  const opts = appointment?.after_options;
  if (appointment && opts) {
    const day = consultationDay(appointment.scheduled_at, tz);
    const usable = (iso: string | null) => {
      const ms = toMs(iso);
      return !isNaN(ms) && ms > now + MIN_LEAD_MS;
    };
    if (usable(opts.after_24h)) {
      out.push({
        value: 'after_24h',
        label: `Until 24 hours after your ${day} consultation (${labelAt(opts.after_24h, tz)})`,
        hint: '',
      });
    }
    if (usable(opts.after_7d)) {
      out.push({ value: 'after_7d', label: `Until 7 days after (${labelAt(opts.after_7d, tz)})`, hint: '' });
    }
    if (usable(opts.after_30d)) {
      out.push({ value: 'after_30d', label: `Until 30 days after (${labelAt(opts.after_30d, tz)})`, hint: '' });
    }
  }
  out.push(
    { value: '24h', label: '24 hours', hint: '' },
    { value: '7d', label: '7 days', hint: '' },
    { value: '30d', label: '30 days', hint: '' },
    { value: 'until', label: 'Until a date', hint: '' },
    { value: 'indefinite', label: 'No end date', hint: 'They can see them until you stop sharing.' },
  );
  return out;
}

/** The default chip: 24 hours after the consultation when offered, else 7 days. */
export function defaultDuration(choices: readonly DurationChoice[]): DocumentShareDuration {
  return choices.some((c) => c.value === 'after_24h') ? 'after_24h' : '7d';
}

/**
 * The exclusive end a choice would give, as ISO: null = no end date,
 * undefined = not known yet (no date picked, option not offered).
 */
export function shareEnd(
  duration: DocumentShareDuration | null | undefined,
  ctx: { now?: number; appointment?: SharingAppointmentRefDto | null; untilDate?: string; tz?: string } = {},
): string | null | undefined {
  if (!duration) return undefined;
  if (duration === 'indefinite') return null;
  const rel = RELATIVE_MS[duration];
  if (rel !== undefined) return new Date((ctx.now ?? Date.now()) + rel).toISOString();
  if (duration === 'until') {
    const iso = ctx.untilDate ? untilDateToExpiresAt(ctx.untilDate, ctx.tz) : '';
    return iso || undefined;
  }
  return isAfterDuration(duration) ? (ctx.appointment?.after_options?.[duration] ?? undefined) : undefined;
}

/** The label of an end `shareEnd` computed ("until" ends read as the day before). */
export function endLabel(duration: DocumentShareDuration | null | undefined, end: string | null | undefined, tz?: string): string {
  if (end === null) return 'No end date';
  const ms = toMs(end);
  if (isNaN(ms)) return '';
  return labelAt(new Date(duration === 'until' ? ms - 1000 : ms).toISOString(), tz);
}

/** True when an end comes before the doctor's next consultation starts. */
export function endsBeforeNext(
  end: string | null | undefined,
  next: SharingAppointmentRefDto | null | undefined,
): boolean {
  if (end === null || end === undefined || !next) return false;
  const e = toMs(end);
  const s = toMs(next.scheduled_at);
  return !isNaN(e) && !isNaN(s) && e < s;
}

/** "This ends before your 28 Oct consultation with Dr Ade." */
export function endsBeforeCopy(next: SharingAppointmentRefDto, doctor: string, tz?: string): string {
  return `This ends before your ${consultationDay(next.scheduled_at, tz)} consultation with ${doctor}.`;
}

/** Compare two ends: later wins, null (no end) beats any date. */
export function laterEnd(a: string | null | undefined, b: string | null | undefined): 'a' | 'b' | 'same' {
  if (a === null && b === null) return 'same';
  if (a === null) return 'a';
  if (b === null) return 'b';
  const x = toMs(a);
  const y = toMs(b);
  if (isNaN(x) || isNaN(y) || x === y) return 'same';
  return x > y ? 'a' : 'b';
}

// ---------------------------------------------------------------------------
// The Medical Documents row chip
// ---------------------------------------------------------------------------

export interface AccessChip {
  readonly icon: string;
  readonly label: string;
  readonly cls: string;
  /** "Until 30 Oct 2026" / "No end date" ('' when private). */
  readonly until: string;
}

const PILL_PRIVATE = 'bg-cloud text-slate';
const PILL_SHARED = 'bg-frost text-cerulean-dark';
const PILL_WARNING = 'bg-warning/15 text-warning-ink';
const PILL_ACTIVE = 'bg-sage/15 text-sage-ink';

/**
 * Who can see a document, as one chip: Private / Shared with Dr X / Shared
 * with 3 doctors (· paused). null when the API didn't say (`shared_with`
 * absent): the chip is hidden then, never guessed.
 */
export function accessChip(sharedWith: readonly DocumentSharedWithDto[] | undefined, tz?: string): AccessChip | null {
  if (!sharedWith) return null;
  if (sharedWith.length === 0) return { icon: 'lock', label: 'Private', cls: PILL_PRIVATE, until: '' };
  const paused = sharedWith.some((s) => s.paused);
  const base =
    sharedWith.length === 1 ? `Shared with ${drName(sharedWith[0].name)}` : `Shared with ${sharedWith.length} doctors`;
  return {
    icon: paused ? 'hourglass' : 'share-2',
    label: paused ? `${base} · paused` : base,
    cls: paused ? PILL_WARNING : PILL_SHARED,
    until: combinedUntil(sharedWith, tz),
  };
}

/** The latest end among several doctors (no end date wins). */
function combinedUntil(list: readonly DocumentSharedWithDto[], tz?: string): string {
  if (list.some((s) => s.indefinite)) return 'No end date';
  let best: string | null = null;
  for (const s of list) {
    if (s.until_label_at && (best === null || toMs(s.until_label_at) > toMs(best))) best = s.until_label_at;
  }
  return untilLabel(best, false, tz);
}

// ---------------------------------------------------------------------------
// Doctors (Manage sharing)
// ---------------------------------------------------------------------------

export interface StatusPill {
  readonly label: string;
  readonly icon: string;
  readonly cls: string;
}

/** True when the doctor can see the whole folder right now. */
export function holdsFolder(d: SharingDoctorDto): boolean {
  return d.access.scope === 'all' && d.access.state === 'active';
}

/**
 * True when the doctor holds a whole-folder share that is paused (they aren't
 * practising on VideoMed now). It resumes — new uploads included — if they
 * come back within 30 days, so uploads must list them too.
 */
export function holdsPausedFolder(d: SharingDoctorDto): boolean {
  return d.access.scope === 'all' && d.access.state === 'paused';
}

/** "Can see your whole folder until …" copy for a folder holder. */
export function folderUntil(d: SharingDoctorDto, tz?: string): string {
  return untilLabel(d.access.folder_until_label_at, d.access.folder_indefinite, tz);
}

type AccessEnds = Pick<
  DoctorAccessSummaryDto,
  'scope' | 'until_label_at' | 'indefinite' | 'folder_until_label_at' | 'folder_indefinite'
>;

/**
 * The end to show beside a doctor's access summary. "All your documents,
 * including new uploads" lasts as long as the whole-folder share itself — not
 * the latest end among everything they can see (a document shared on its own
 * with no end date doesn't keep new uploads coming) — so a folder holder gets
 * the folder share's end; anyone else the latest end of their shares.
 */
function accessEnd(a: AccessEnds): { at: string | null; indefinite: boolean } {
  return a.scope === 'all'
    ? { at: a.folder_until_label_at, indefinite: a.folder_indefinite }
    : { at: a.until_label_at, indefinite: a.indefinite };
}

/** "until 30 Oct 2026" / "with no end date" for a summary sentence (see {@link accessEnd}). */
export function accessUntilPhrase(a: AccessEnds, tz?: string): string {
  const end = accessEnd(a);
  return untilPhrase(end.at, end.indefinite, tz);
}

/** "Until 30 Oct 2026" / "No end date" on its own line (see {@link accessEnd}). */
export function accessUntilLabel(a: AccessEnds, tz?: string): string {
  const end = accessEnd(a);
  return untilLabel(end.at, end.indefinite, tz);
}

/** Sharing / Paused / Request waiting / Not sharing. */
export function doctorStatus(d: SharingDoctorDto): StatusPill {
  if (d.access.state === 'paused') return { label: 'Paused', icon: 'hourglass', cls: PILL_WARNING };
  if (d.pending_request?.status === 'pending') return { label: 'Request waiting', icon: 'key-round', cls: PILL_WARNING };
  if (d.access.state === 'active') return { label: 'Sharing', icon: 'shield-check', cls: PILL_ACTIVE };
  return { label: 'Not sharing', icon: 'lock', cls: PILL_PRIVATE };
}

/** What a doctor can see, in one line (from the access summary and their active grants). */
export function doctorSummary(d: SharingDoctorDto, grants: readonly DocumentGrantDto[] = []): string {
  const a = d.access;
  if (a.state === 'none') return "Can't see any of your documents";
  const mine = grants.filter((g) => g.specialist.id === d.specialist.id && (g.status === 'active' || g.status === 'paused'));
  const individually = new Set<string>();
  for (const g of mine) if (g.scope === 'selected') for (const id of g.document_ids) individually.add(id);
  let text: string;
  if (a.scope === 'all') {
    text =
      individually.size > 0
        ? `Can see all your documents, including new uploads, and ${individually.size} shared individually`
        : 'Can see all your documents, including new uploads';
  } else {
    text = `Can see ${countNoun(a.document_count, 'document')}`;
  }
  if (a.hidden_count > 0) text += ` · ${a.hidden_count} hidden from them`;
  return text;
}

/** "Last opened 12 Oct 2026" / "Not opened yet". */
export function lastOpenedLabel(iso: string | null | undefined, withTime = false, tz?: string): string {
  const label = withTime ? dateTimeLabel(iso, tz) : dateLabel(iso, tz);
  return label ? `Last opened ${label}` : 'Not opened yet';
}

/** The grant to change first: the folder share, else the latest-ending selected one. */
export function mainGrant(grants: readonly DocumentGrantDto[]): DocumentGrantDto | null {
  if (grants.length === 0) return null;
  const folder = grants.find((g) => g.scope === 'all');
  if (folder) return folder;
  return [...grants].sort((x, y) => {
    const w = laterEnd(x.expires_at, y.expires_at);
    return w === 'a' ? -1 : w === 'b' ? 1 : 0;
  })[0];
}

const SOURCE_SUFFIX: Record<DocumentGrantDto['source'], string> = {
  share: '',
  upload: ' · when you uploaded',
  booking: ' · when you booked',
  request: ' · from their request',
  restore: ' · restored',
};

/** "Whole folder" / "3 documents". */
export function grantWhat(g: DocumentGrantDto): string {
  return g.scope === 'all' ? 'Whole folder' : countNoun(g.document_count, 'document');
}

/** A grant is open-ended (no end date). */
export function grantIndefinite(g: DocumentGrantDto): boolean {
  return g.duration === 'indefinite' || (g.expires_at === null && !isAfterDuration(g.duration));
}

/** "Whole folder · Until 30 Oct 2026 · Shared 12 Oct 2026 · from their request". */
export function grantSummary(g: DocumentGrantDto, tz?: string): string {
  const until = untilLabel(g.until_label_at, grantIndefinite(g), tz);
  return [grantWhat(g), until, `Shared ${dateLabel(g.created_at, tz)}`].filter(Boolean).join(' · ') + SOURCE_SUFFIX[g.source];
}

const END_REASON: Record<string, string> = {
  revoked: 'Stopped by you',
  expired: 'Time ran out',
  appointment_cancelled: 'Consultation cancelled',
  doctor_unavailable: 'Doctor was away from VideoMed',
  emptied: 'No documents left in it',
  merged: 'Combined with another share',
  account_closed: 'Account closed',
};

/** "Dr Ade · Whole folder · Ended 12 Oct 2026 (Time ran out)". */
export function endedGrantSummary(g: DocumentGrantDto, tz?: string): string {
  const reason =
    g.end_reason === 'revoked' && g.ended_by === 'system'
      ? 'Ended by VideoMed'
      : (END_REASON[g.end_reason ?? (g.status === 'expired' ? 'expired' : '')] ?? 'Ended');
  const ended = dateLabel(g.ended_at ?? g.expires_at, tz);
  return `${drName(g.specialist.name)} · ${grantWhat(g)} · Ended ${ended} (${reason})`;
}

// ---------------------------------------------------------------------------
// Activity (the disclosure ledger)
// ---------------------------------------------------------------------------

export interface HistoryRow {
  readonly key: string;
  readonly icon: string;
  readonly text: string;
  /** The newest event's time. */
  readonly at: string;
  /** Views folded into this row (1 for everything else). */
  readonly count: number;
}

const FOLD_MS = 10 * 60_000;

function eventUntil(e: DocumentAccessEventDto, tz?: string): string {
  const d = e.details;
  if (!d) return '';
  const indefinite = d.duration === 'indefinite' || (d.expires_at === null && !d.until_label_at && !isAfterDuration(d.duration));
  return untilLabel(d.until_label_at ?? null, indefinite, tz);
}

function eventText(e: DocumentAccessEventDto, count: number, tz?: string): { icon: string; text: string } {
  const doctor = drName(e.specialist?.name);
  const title = e.document ? (e.document.title ?? 'a document you removed') : 'a document';
  const until = eventUntil(e, tz);
  const withUntil = (text: string) => (until ? `${text} · ${until}` : text);
  const system = e.actor === 'system';
  switch (e.event) {
    case 'viewed':
      return { icon: 'eye', text: cap(`${doctor} opened ${title}${count > 1 ? ` (${count} times)` : ''}`) };
    case 'shared': {
      const what =
        e.details?.scope === 'all'
          ? 'your whole folder'
          : countNoun(Math.max(1, e.details?.document_count ?? 1), 'document');
      return { icon: 'share-2', text: withUntil(`You shared ${what} with ${doctor}`) };
    }
    case 'changed':
      return { icon: 'pen-line', text: `You changed what ${doctor} can see` };
    case 'extended':
      return {
        icon: 'calendar-clock',
        text: system
          ? withUntil(`Sharing with ${doctor} moved with your rescheduled consultation`)
          : withUntil(`You changed how long ${doctor} can see your documents`),
      };
    case 'revoked': {
      const reason = e.details?.end_reason;
      if (!system) {
        // Ends the patient caused without stopping anything: a share folded
        // into the whole-folder share (access widened), or one left empty.
        if (reason === 'merged') {
          return { icon: 'folder-open', text: `Your shares with ${doctor} were combined into one whole-folder share` };
        }
        if (reason === 'emptied') {
          return { icon: 'user-x', text: `Your share with ${doctor} ended because no documents were left in it` };
        }
        return { icon: 'user-x', text: `You stopped sharing with ${doctor}` };
      }
      const why =
        reason === 'appointment_cancelled'
          ? ' because the consultation was cancelled'
          : reason === 'emptied'
            ? ' because no documents were left in it'
            : reason === 'doctor_unavailable' || reason === undefined
              ? ' because they were away from VideoMed'
              : '';
      return { icon: 'user-x', text: `Sharing with ${doctor} ended${why}` };
    }
    case 'restored':
      return { icon: 'undo-2', text: `You restored sharing with ${doctor}` };
    case 'document_removed':
      return { icon: 'eye-off', text: `You removed ${possessive(doctor)} access to ${title}` };
    case 'document_shown':
      return { icon: 'eye', text: `You let ${doctor} see ${title} again` };
    case 'expired':
      return { icon: 'hourglass', text: cap(`${possessive(doctor)} access ended`) };
    case 'requested':
      return { icon: 'key-round', text: cap(`${doctor} asked to see your documents`) };
    case 'request_approved':
      return { icon: 'circle-check', text: `You approved ${possessive(doctor)} request` };
    case 'request_declined':
      return { icon: 'circle-x', text: `You declined ${possessive(doctor)} request` };
    case 'request_cancelled':
      // Closed by the system (they stopped practising, the consultation was
      // cancelled) — not withdrawn by the doctor.
      return system
        ? { icon: 'undo-2', text: cap(`${possessive(doctor)} request closed`) }
        : { icon: 'undo-2', text: cap(`${doctor} withdrew their request`) };
    case 'request_expired':
      return { icon: 'clock', text: cap(`${possessive(doctor)} request closed without an answer`) };
    case 'requests_blocked':
      return { icon: 'bell-off', text: `You stopped ${doctor} from asking for access` };
    case 'requests_allowed':
      return { icon: 'key-round', text: `You allowed ${doctor} to ask for access again` };
    default:
      return { icon: 'history', text: 'Sharing changed' };
  }
}

/**
 * Ledger rows for display, newest first. Consecutive views of the same
 * document by the same doctor within 10 minutes of each other fold into one
 * "… opened {title} (3 times)" row (every view is still recorded).
 */
export function historyRows(events: readonly DocumentAccessEventDto[], tz?: string): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let group: { first: DocumentAccessEventDto; last: DocumentAccessEventDto; count: number } | null = null;
  const flush = () => {
    if (!group) return;
    const { icon, text } = eventText(group.first, group.count, tz);
    rows.push({ key: group.first.id, icon, text, at: group.first.created_at, count: group.count });
    group = null;
  };
  for (const e of events) {
    if (
      group &&
      e.event === 'viewed' &&
      group.first.event === 'viewed' &&
      e.specialist?.id === group.first.specialist?.id &&
      e.document?.id === group.first.document?.id &&
      Math.abs(toMs(group.last.created_at) - toMs(e.created_at)) <= FOLD_MS
    ) {
      group.last = e;
      group.count += 1;
      continue;
    }
    flush();
    group = { first: e, last: e, count: 1 };
  }
  flush();
  return rows;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** "Dr Ade asked to see your documents" (an extension: "… to keep seeing …"). */
export function requestTitle(r: DocumentAccessRequestDto): string {
  const doctor = drName(r.specialist.name);
  return r.kind === 'extend' ? `${doctor} asked to keep seeing your documents` : `${doctor} asked to see your documents`;
}

/** "Asked 20 Oct 2026 · For your 28 Oct consultation · Closes 27 Oct 2026". */
export function requestMeta(r: DocumentAccessRequestDto, tz?: string): string {
  const parts = [`Asked ${dateLabel(r.created_at, tz)}`];
  if (r.appointment) parts.push(`For your ${consultationDay(r.appointment.scheduled_at, tz)} consultation`);
  parts.push(`Closes ${dateLabel(r.expires_at, tz)}`);
  return parts.join(' · ');
}

/** The info copy for a request that is no longer pending ('' while pending). */
export function requestStatusCopy(status: DocumentAccessRequestStatus, doctorName: string): string {
  switch (status) {
    case 'approved':
      return "You've already approved this request.";
    case 'declined':
      return 'You declined this request.';
    case 'cancelled':
      return `${drName(doctorName)} withdrew this request.`;
    case 'expired':
      return 'This request closed without an answer. Nothing was shared.';
    default:
      return '';
  }
}

const AFTER_WORDS: Record<AfterDuration, string> = {
  after_24h: '24 hours',
  after_7d: '7 days',
  after_30d: '30 days',
};

/** The approve dialog's summary card, from the server's suggestion. */
export function suggestionSummary(
  r: DocumentAccessRequestDto,
  now: number = Date.now(),
  tz?: string,
): { sees: string; until: string } | null {
  const s = r.suggestion;
  if (!s.scope) return null;
  const sees =
    s.scope === 'all'
      ? 'All your documents, including new uploads'
      : `The ${countNoun(s.document_ids.length, 'file')} you attached for this consultation`;
  return { sees, until: durationText(s.duration, r.appointment, now, tz) };
}

/** A duration in words, for a summary: "7 days after your 28 Oct consultation (4 Nov 2026, 4:30 PM)". */
export function durationText(
  duration: DocumentShareDuration,
  appointment: SharingAppointmentRefDto | null | undefined,
  now: number = Date.now(),
  tz?: string,
  untilDate?: string,
): string {
  if (isAfterDuration(duration)) {
    const end = appointment?.after_options?.[duration] ?? null;
    const day = appointment ? consultationDay(appointment.scheduled_at, tz) : '';
    const base = day ? `${AFTER_WORDS[duration]} after your ${day} consultation` : `${AFTER_WORDS[duration]} after the consultation`;
    return end ? `${base} (${labelAt(end, tz)})` : base;
  }
  const end = shareEnd(duration, { now, appointment, untilDate, tz });
  return end === null ? 'No end date' : endLabel(duration, end, tz);
}

// ---------------------------------------------------------------------------
// The share form
// ---------------------------------------------------------------------------

export interface ShareFormState {
  readonly doctorIds: readonly string[];
  readonly scope: DocumentShareScope | null;
  readonly documentIds: readonly string[];
  readonly duration: DocumentShareDuration | null;
  /** 'YYYY-MM-DD' for "Until a date". */
  readonly untilDate: string;
  /** The consultation `after_*` choices are anchored to. */
  readonly appointment: SharingAppointmentRefDto | null;
}

/** Why the "What" step can't continue ('' when it can). */
export function whatError(s: Pick<ShareFormState, 'scope' | 'documentIds'>): string {
  if (!s.scope) return 'Choose what they can see.';
  if (s.scope === 'selected' && s.documentIds.length === 0) return 'Choose at least one document.';
  if (s.scope === 'selected' && s.documentIds.length > MAX_SHARE_DOCUMENTS) {
    return `You can share up to ${MAX_SHARE_DOCUMENTS} documents at a time.`;
  }
  return '';
}

/** Why the "How long" step can't continue ('' when it can). */
export function durationError(
  s: Pick<ShareFormState, 'duration' | 'untilDate' | 'appointment'>,
  bounds = untilDateBounds(),
): string {
  if (!s.duration) return 'Choose how long they can see them.';
  if (s.duration === 'until') return untilDateError(s.untilDate, bounds);
  if (isAfterDuration(s.duration) && !s.appointment?.after_options?.[s.duration]) {
    return 'Choose another option — this one is no longer available.';
  }
  return '';
}

/** Whether the share can be sent. */
export function canSubmitShare(s: ShareFormState, bounds = untilDateBounds()): boolean {
  return (
    s.doctorIds.length >= 1 &&
    s.doctorIds.length <= MAX_SHARE_DOCTORS &&
    whatError(s) === '' &&
    durationError(s, bounds) === ''
  );
}

/**
 * The POST body for a share. The appointment only rides along when it anchors
 * the end (`after_*`): the API validates any `appointment_id` it gets and
 * refuses a follow-up proposal's, so sending it with another duration could
 * only make a share fail.
 */
export function shareInput(
  s: ShareFormState,
  extra: {
    clientKey: string;
    surface: DocumentShareSurface;
    answersRequestId?: string | null;
    showHiddenFor?: readonly string[];
    tz?: string;
  },
): CreateDocumentShareInput {
  const duration = s.duration ?? '7d';
  const input: CreateDocumentShareInput = {
    specialist_ids: [...s.doctorIds],
    scope: s.scope ?? 'selected',
    duration,
    client_key: extra.clientKey,
    surface: extra.surface,
  };
  if (input.scope === 'selected') input.document_ids = [...s.documentIds];
  if (duration === 'until') input.expires_at = untilDateToExpiresAt(s.untilDate, extra.tz);
  if (s.appointment && isAfterDuration(duration)) input.appointment_id = s.appointment.id;
  if (extra.answersRequestId) input.answers_request_id = extra.answersRequestId;
  const show = (extra.showHiddenFor ?? []).filter((id) => s.doctorIds.includes(id));
  if (input.scope === 'all' && show.length > 0) input.show_hidden_for_specialist_ids = show;
  return input;
}

/** The host's success line, built from what the API answered. */
export function shareResultLine(result: DocumentShareResultDto, tz?: string): string {
  const outcomes = result.outcomes;
  const grantFor = (id: string) => result.grants.find((g) => g.id === id) ?? null;
  if (outcomes.length === 0) return 'Shared.';
  if (outcomes.length > 1) return `Shared with ${outcomes.length} doctors.`;
  const o = outcomes[0];
  const g = grantFor(o.grant_id);
  const doctor = drName(g?.specialist.name);
  const tail = g ? untilPhrase(g.until_label_at, grantIndefinite(g), tz) : '';
  if (o.outcome === 'unchanged' && g?.scope === 'all') {
    return `${cap(doctor)} could already see your whole folder${tail ? ` ${tail}` : ''}.`;
  }
  return `Shared with ${doctor}${tail ? ` ${tail}` : ''}.`;
}

/**
 * The booking confirmation when the attached files were shared (spec §6.7),
 * from the booking's answer: "Booked. Your files are shared with Dr Ade until
 * 29 Oct 2026, 4:30 PM." A booking share's label is null only with no end date.
 */
export function bookedShareLine(doctorName: string | null | undefined, untilLabelAt: string | null, tz?: string): string {
  const tail = untilPhrase(untilLabelAt, untilLabelAt === null, tz);
  return `Booked. Your files are shared with ${drName(doctorName)}${tail ? ` ${tail}` : ''}.`;
}

/** "Approved. Dr Ade can see all your documents, including new uploads until 4 Nov 2026." */
export function approvedLine(g: DocumentGrantDto, tz?: string): string {
  const what =
    g.scope === 'all' ? 'all your documents, including new uploads' : countNoun(g.document_count, 'document');
  const tail = untilPhrase(g.until_label_at, grantIndefinite(g), tz);
  return `Approved. ${cap(drName(g.specialist.name))} can see ${what}${tail ? ` ${tail}` : ''}.`;
}

/**
 * The existing-folder notice on the review step for one doctor (a create
 * never shortens a folder share): "Dr Ade can already see your whole folder
 * until 30 Oct 2026. This extends it to 6 Nov 2026." / "… That stays as it is."
 * `newEnd` is the exclusive end the share would give (null = no end date),
 * `newLabel` its display label.
 */
export function folderNotice(
  d: SharingDoctorDto,
  newEnd: string | null | undefined,
  newLabel: string,
  tz?: string,
): string {
  if (!holdsFolder(d)) return '';
  const doctor = cap(drName(d.specialist.name));
  const current = d.access.folder_indefinite ? null : (d.access.folder_until_label_at ?? undefined);
  const phrase = untilPhrase(d.access.folder_until_label_at, d.access.folder_indefinite, tz);
  const now = phrase ? ` ${phrase}` : '';
  const extends_ =
    newEnd !== undefined &&
    current !== null &&
    (newEnd === null || (current !== undefined && toMs(newEnd) > toMs(current) + 1000));
  const tail = extends_
    ? ` This extends it ${newEnd === null ? 'to no end date' : `to ${newLabel}`}.`
    : ' That stays as it is.';
  return `${doctor} can already see your whole folder${now}.${tail}`;
}

// ---------------------------------------------------------------------------
// Upload: "Who can see these files?"
// ---------------------------------------------------------------------------

export interface UploadShareState {
  readonly mode: 'private' | 'share';
  readonly doctorIds: readonly string[];
  readonly duration: DocumentShareDuration;
  readonly untilDate: string;
  readonly appointmentId: string | null;
  readonly batchId: string;
  /** The folder-share holders listed in the folder section. */
  readonly folderDoctorIds: readonly string[];
  /** Ticked "Also let Dr X see these files". */
  readonly folderTicks: Readonly<Record<string, boolean>>;
  readonly surface: 'documents_page' | 'appointment_details';
  readonly tz?: string;
}

/**
 * Folder ticks to start with: all ticked on the documents page; from an
 * appointment only its doctor. Paused folder holders are never ticked: the
 * patient opts them in explicitly.
 */
export function defaultFolderTicks(
  folderDoctorIds: readonly string[],
  appointmentDoctorId: string | null,
  pausedDoctorIds: readonly string[] = [],
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of folderDoctorIds) {
    out[id] = !pausedDoctorIds.includes(id) && (appointmentDoctorId ? id === appointmentDoctorId : true);
  }
  return out;
}

/** The multipart sharing fields for every file of one batch. */
export function uploadShareOptions(s: UploadShareState): UploadShareOptions {
  const share = s.mode === 'share' ? s.doctorIds.filter(Boolean) : [];
  const exclude = s.folderDoctorIds.filter((id) => !share.includes(id) && !s.folderTicks[id]);
  const out: UploadShareOptions = { specialist_ids: [...share], exclude_specialist_ids: exclude, surface: s.surface };
  if (share.length > 0) {
    out.duration = s.duration;
    out.batch_id = s.batchId;
    if (s.duration === 'until') out.expires_at = untilDateToExpiresAt(s.untilDate, s.tz);
    // Only an `after_*` end needs (and may carry) the consultation — see `shareInput`.
    if (s.appointmentId && isAfterDuration(s.duration)) out.appointment_id = s.appointmentId;
  }
  return out;
}

/**
 * The upload success lines, from the responses (`share_outcome`,
 * `shared_with`, `share_ended_for`). `nameOf` names a doctor id.
 */
export function uploadOutcomeLines(
  responses: readonly Pick<UploadedDocumentDto, 'shared_with' | 'share_outcome' | 'share_ended_for'>[],
  nameOf: (specialistId: string) => string,
  tz?: string,
): string[] {
  const lines: string[] = [];
  if (responses.length === 0) return lines;
  const unavailable = responses.some((r) => r.share_outcome === 'sharing_unavailable');
  const direct = new Map<string, DocumentSharedWithDto>();
  const folder = new Map<string, string>();
  const ended = new Map<string, number>();
  for (const r of responses) {
    for (const s of r.shared_with ?? []) {
      if (s.via === 'document') {
        if (!direct.has(s.specialist_id)) direct.set(s.specialist_id, s);
      } else {
        folder.set(s.specialist_id, s.name);
      }
    }
    for (const id of r.share_ended_for ?? []) ended.set(id, (ended.get(id) ?? 0) + 1);
  }
  for (const id of direct.keys()) folder.delete(id);
  const many = responses.length > 1;
  if (unavailable) lines.push('Saved privately. Sharing is unavailable right now — you can share later.');
  if (direct.size > 0) {
    const first = [...direct.values()][0];
    const tail = untilPhrase(first.until_label_at, first.indefinite, tz);
    const who = direct.size === 1 ? drName(first.name) : `${direct.size} doctors`;
    lines.push(`Shared with ${who}${tail ? ` ${tail}` : ''}.`);
  }
  for (const name of folder.values()) {
    lines.push(`${cap(drName(name))} can also see ${many ? 'them' : 'it'} through your whole-folder share.`);
  }
  for (const [id, n] of ended) {
    lines.push(
      `Saved, but your share with ${drName(nameOf(id))} had already ended, so they can't see ${n === 1 ? 'this file' : 'these files'}. You can share again from Manage sharing.`,
    );
  }
  if (!unavailable && direct.size === 0 && folder.size === 0 && ended.size === 0) {
    lines.push('Kept private — only you can see them.');
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Booking step 5
// ---------------------------------------------------------------------------

export type BookingShareChoice = 'share' | 'private';

export const BOOKING_DURATIONS: readonly { readonly value: BookingShareDuration; readonly label: string }[] = [
  { value: 'after_24h', label: 'Until 24 hours after the consultation' },
  { value: 'after_7d', label: 'Until 7 days after' },
  { value: 'after_30d', label: 'Until 30 days after' },
  { value: 'indefinite', label: 'No end date' },
];

/** The two radio cards of "Can Dr X see these files?". */
export function bookingShareCards(
  doctorName: string,
  bookedDoctor: SharingDoctorDto | null | undefined,
): Record<BookingShareChoice, { label: string; hint: string }> {
  const doctor = drName(doctorName);
  const folder = !!bookedDoctor && holdsFolder(bookedDoctor);
  return {
    share: { label: `Share with ${doctor}`, hint: 'They can see these files.' },
    private: folder
      ? { label: `Don't share with ${doctor}`, hint: `${cap(doctor)} can see your whole folder, but not these files.` }
      : { label: 'Keep private', hint: 'Only you can see them. You can share later.' },
  };
}

/** Booking needs a choice once files are attached. */
export function bookingShareReady(attachedCount: number, choice: BookingShareChoice | null): boolean {
  return attachedCount === 0 || choice !== null;
}

/** The booking's `document_share` (only with attachments). */
export function bookingDocumentShare(
  attachedCount: number,
  choice: BookingShareChoice | null,
  duration: BookingShareDuration,
  showIds: readonly string[],
): { duration: BookingShareDuration | null; show_specialist_ids: string[] } | undefined {
  if (attachedCount === 0) return undefined;
  return { duration: choice === 'share' ? duration : null, show_specialist_ids: [...showIds] };
}

/** Step 6 "Shared with doctor" value. */
export function bookingShareSummary(choice: BookingShareChoice | null, duration: BookingShareDuration): string {
  if (choice !== 'share') return 'Not shared';
  switch (duration) {
    case 'after_24h':
      return 'Until 24 hours after the consultation';
    case 'after_7d':
      return 'Until 7 days after the consultation';
    case 'after_30d':
      return 'Until 30 days after the consultation';
    default:
      return 'No end date';
  }
}

/** Folder-share holders other than the booked doctor. */
export function otherFolderHolders(doctors: readonly SharingDoctorDto[], bookedId: string): SharingDoctorDto[] {
  return doctors.filter((d) => holdsFolder(d) && d.specialist.id !== bookedId);
}
