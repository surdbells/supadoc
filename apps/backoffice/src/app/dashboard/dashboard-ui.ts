import type {
  AdminDashboardAttentionItem,
  AdminDashboardAttentionKey,
  AdminDashboardKpi,
  AdminDashboardKpiKey,
  AdminDashboardPeriod,
} from '@supadoc/models';
import { FOCUS_RING } from '../shared/layout';

/**
 * Shared look + wording for the back-office dashboard (route `/dashboard`).
 * Pure functions and class strings only, so every section reads the same and
 * the rules are unit-tested (dashboard-ui.spec.ts). The visual language is the
 * doctor portal's dashboard: section cards with a bordered header, stat tiles
 * with a tinted icon chip.
 *
 * Card chrome, stat tiles, page header and notices come from the console's
 * spacing tokens (`../shared/layout`: LIST_CARD, LIST_CARD_HEAD, SECTION_TITLE,
 * LIST_CARD_FOOT, LIST_CARD_EMPTY, STAT_TILE …); only the strings below are
 * the dashboard's own.
 */

// ----- Dashboard-only chrome -----

/** A small text link in a card header. */
export const HEAD_LINK =
  'inline-flex min-h-9 items-center gap-1 rounded-lg font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean ' +
  FOCUS_RING;
/**
 * A list row inside a card that is itself the link (hover wash + inset focus
 * ring) — unlike layout's ROW_LINK, which overlays a row of a people list.
 */
export const ROW_LINK =
  'flex min-h-11 items-center gap-3 px-5 py-3.5 transition-colors hover:bg-glacier focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cerulean/40';
/** The same row when it is not a link. */
export const ROW_STATIC = 'flex min-h-11 items-center gap-3 px-5 py-3.5';
/** A small muted sub-heading inside a card ("In progress", "All clear"). */
export const GROUP_LABEL = 'px-5 pt-4 pb-1 font-sans text-caption font-semibold uppercase tracking-[0.6px] text-slate';

// ----- Periods -----

export interface PeriodOption {
  readonly key: AdminDashboardPeriod;
  readonly label: string;
}

export const DASHBOARD_PERIODS: readonly PeriodOption[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

/** `?period=` from the URL; anything unknown is today (the default). */
export function parsePeriod(value: string | null | undefined): AdminDashboardPeriod {
  return value === '7d' || value === '30d' ? value : 'today';
}

/** What the KPI deltas compare with. */
export function compareLabel(period: AdminDashboardPeriod): string {
  if (period === '7d') return 'vs previous 7 days';
  if (period === '30d') return 'vs previous 30 days';
  return 'vs this time yesterday';
}

/** "today" / "in the last 7 days" — for sentences. */
export function periodPhrase(period: AdminDashboardPeriod): string {
  if (period === '7d') return 'in the last 7 days';
  if (period === '30d') return 'in the last 30 days';
  return 'today';
}

/** The breakdown cards' caption (they count consultations scheduled in the period, later today included). */
export function breakdownCaption(period: AdminDashboardPeriod): string {
  if (period === 'today') return 'Consultations scheduled for today';
  return `Consultations scheduled ${periodPhrase(period)}`;
}

// ----- Numbers -----

const COUNT = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 });

export function formatCount(n: number | null | undefined): string {
  return COUNT.format(Number(n) || 0);
}

/** "1 review" / "3 reviews". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

export function currencySymbol(currency: string | null | undefined): string {
  const c = (currency || 'NGN').toUpperCase();
  return c === 'NGN' ? '₦' : `${c} `;
}

/**
 * Money, e.g. "₦12,500" (no kobo when whole) or "₦12,500.50"; `compact` gives
 * "₦12.5K" / "₦1.25M" for tiles and axes. A dash for nothing.
 */
export function formatMoney(
  amount: string | number | null | undefined,
  currency = 'NGN',
  opts: { compact?: boolean } = {},
): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  const sym = currencySymbol(currency);
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  if (opts.compact && abs >= 1000) return sign + sym + compactNumber(abs);
  const whole = Math.round(abs * 100) % 100 === 0;
  return (
    sign +
    sym +
    abs.toLocaleString('en-NG', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })
  );
}

/**
 * 950 → "950", 1,284 → "1.3K", 12,900 → "12.9K", 1,250,000 → "1.25M". A value
 * that rounds up to the next unit takes it (999,999.5 → "1M", never "1000K").
 */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  const fmt = (v: number, digits: number) => String(Number(v.toFixed(digits)));
  if (abs >= 1_000_000_000) return `${sign}${fmt(abs / 1_000_000_000, 2)}B`;
  if (abs >= 1_000_000) {
    const m = fmt(abs / 1_000_000, 2);
    return Number(m) >= 1000 ? `${sign}${fmt(abs / 1_000_000_000, 2)}B` : `${sign}${m}M`;
  }
  if (abs >= 1_000) {
    const k = fmt(abs / 1_000, abs >= 100_000 ? 0 : 1);
    return Number(k) >= 1000 ? `${sign}${fmt(abs / 1_000_000, 2)}M` : `${sign}${k}K`;
  }
  return `${sign}${fmt(abs, abs % 1 === 0 ? 0 : 1)}`;
}

// ----- KPI tiles -----

interface TileLook {
  readonly icon: string;
  /** The icon chip's background + icon colour. */
  readonly tint: string;
}

const KPI_LOOK: Record<AdminDashboardKpiKey, TileLook> = {
  bookings: { icon: 'calendar-days', tint: 'bg-frost text-cerulean' },
  consultations_completed: { icon: 'circle-check', tint: 'bg-sage/15 text-sage' },
  revenue: { icon: 'banknote', tint: 'bg-sage/15 text-sage' },
  wallet_topups: { icon: 'wallet', tint: 'bg-cerulean/10 text-cerulean' },
  refunds: { icon: 'undo-2', tint: 'bg-warning/15 text-warning' },
  new_patients: { icon: 'user-plus', tint: 'bg-cerulean/10 text-cerulean' },
  active_doctors: { icon: 'stethoscope', tint: 'bg-teal/10 text-teal' },
  cancellations: { icon: 'circle-x', tint: 'bg-alert/10 text-alert' },
  missed: { icon: 'calendar-x', tint: 'bg-ocean/10 text-ocean' },
  average_rating: { icon: 'star', tint: 'bg-warning/15 text-warning' },
};

export function kpiLook(key: string): TileLook {
  return KPI_LOOK[key as AdminDashboardKpiKey] ?? { icon: 'activity', tint: 'bg-frost text-cerulean' };
}

/** The change line under a tile's value: arrow + words + colour (never colour alone). */
export interface KpiDelta {
  readonly direction: 'up' | 'down' | 'flat';
  readonly icon: string;
  /** "Up 12.5%", "Down 3%", "Up from 0", "No change". */
  readonly text: string;
  readonly tone: 'good' | 'bad' | 'neutral';
  /**
   * The arrow's tinted circle (the colour lives on the icon; the words stay
   * ink, so small text keeps its contrast).
   */
  readonly chip: string;
  /** For screen readers: the change, what it compares with, the previous value and whether it is good. */
  readonly srText: string;
}

const TONE_CHIP: Record<KpiDelta['tone'], string> = {
  good: 'bg-sage/15 text-sage',
  bad: 'bg-alert/10 text-alert',
  neutral: 'bg-cloud text-slate',
};

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "12.5" → "12.5%", 100 → "100%", 3.0 → "3%". */
function pct(v: number): string {
  return `${Number(Math.abs(v).toFixed(1)).toLocaleString('en-NG')}%`;
}

/** Tile money from this size is compacted ("₦250K"); below it, whole naira ("₦99,999"). */
export const KPI_COMPACT_FROM = 100_000;

/**
 * A KPI value in words for the tile ("₦1.25M", "₦250K", "₦12,501", "128",
 * "4.80"). Money is kept short enough for a two-up tile on a 375px phone; the
 * exact amount (kobo included) is the tile's title and screen-reader text
 * (`kpiExact`).
 */
export function kpiValue(k: AdminDashboardKpi, currency: string): string {
  if (k.format === 'money') {
    const n = num(k.value);
    if (n === null) return formatMoney(null, currency);
    if (Math.abs(n) >= KPI_COMPACT_FROM) return formatMoney(n, currency, { compact: true });
    return formatMoney(Math.sign(n) * Math.round(Math.abs(n)), currency);
  }
  if (k.format === 'rating') {
    const n = num(k.value);
    return n === null ? '—' : n.toFixed(2);
  }
  return formatCount(num(k.value));
}

/** The exact value (the tile's tooltip / screen-reader text), e.g. "₦1,250,000.50". */
export function kpiExact(k: AdminDashboardKpi, currency: string, value: number | string | null = k.value): string {
  if (k.format === 'money') return formatMoney(value, currency);
  if (k.format === 'rating') {
    const n = num(value);
    return n === null ? 'no reviews' : `${n.toFixed(2)} out of 5`;
  }
  return formatCount(num(value));
}

/**
 * The change against the previous equal period, or null for a snapshot
 * (`previous` null, e.g. active doctors) or a rating with nothing to compare.
 * Up is good for bookings and revenue, bad for refunds, cancellations, missed.
 */
export function kpiDelta(k: AdminDashboardKpi, compare: string, currency = 'NGN'): KpiDelta | null {
  const value = num(k.value);
  const previous = num(k.previous);
  if (previous === null || value === null) return null;

  let direction: KpiDelta['direction'];
  if (k.trend === 'up' || k.trend === 'down' || k.trend === 'flat') direction = k.trend;
  else direction = value > previous ? 'up' : value < previous ? 'down' : 'flat';

  let text: string;
  if (direction === 'flat') text = 'No change';
  else if (k.change_pct !== null && k.change_pct !== undefined) text = `${direction === 'up' ? 'Up' : 'Down'} ${pct(k.change_pct)}`;
  else if (previous === 0) text = direction === 'up' ? 'Up from 0' : 'Down';
  else text = direction === 'up' ? 'Up' : 'Down';

  const tone: KpiDelta['tone'] =
    direction === 'flat' ? 'neutral' : (direction === 'up') === k.higher_is_better ? 'good' : 'bad';
  const verdict = tone === 'good' ? 'better' : tone === 'bad' ? 'worse' : '';
  const srText =
    `${text} ${compare} (was ${kpiExact(k, currency, k.previous)})` + (verdict ? `, ${verdict}` : '');

  return {
    direction,
    icon: direction === 'up' ? 'trending-up' : direction === 'down' ? 'trending-down' : 'minus',
    text,
    tone,
    chip: TONE_CHIP[tone],
    srText,
  };
}

/** Small muted text beside the value ("12 reviews", "8 top-ups"). */
export function kpiInlineSub(k: AdminDashboardKpi): string | null {
  const c = k.count;
  switch (k.key) {
    case 'revenue':
      return c === null ? null : plural(c, 'paid booking');
    case 'wallet_topups':
      return c === null ? null : plural(c, 'top-up');
    case 'refunds':
      return c === null ? null : plural(c, 'refund');
    case 'average_rating':
      return c === null || c === 0 ? null : plural(c, 'review');
    default:
      return null;
  }
}

const MISSED_PARTS: readonly [string, string][] = [
  ['patient', 'Patient'],
  ['doctor', 'Doctor'],
  ['both', 'Both'],
  ['unknown', 'Not recorded'],
];

/**
 * A line under the change: who didn't come for missed consultations
 * ("Patient 3 · Doctor 1"), how many approved doctors for active doctors.
 */
export function kpiNote(k: AdminDashboardKpi): string | null {
  const b = k.breakdown ?? null;
  if (k.key === 'missed' && b) {
    const parts = MISSED_PARTS.filter(([key]) => (b[key] ?? 0) > 0).map(([key, label]) => `${label} ${formatCount(b[key])}`);
    return parts.length ? `No-show: ${parts.join(' · ')}` : null;
  }
  if (k.key === 'active_doctors' && b && typeof b['approved'] === 'number') {
    return `of ${formatCount(b['approved'])} approved`;
  }
  if (k.key === 'average_rating' && num(k.value) === null) return 'No reviews in this period';
  return null;
}

// ----- Needs your attention -----

const ATTENTION_ICON: Record<AdminDashboardAttentionKey, string> = {
  appointments_attention: 'calendar-clock',
  doctor_reviews_pending: 'user-check',
  credentials_to_verify: 'file-check',
  profile_change_requests: 'square-pen',
  licences_expiring: 'hourglass',
  licences_expired: 'badge-alert',
  payouts_awaiting_approval: 'banknote',
  support_open: 'headphones',
  topups_held: 'wallet',
  card_payments_review: 'credit-card',
};

const ATTENTION_TINT: Record<AdminDashboardAttentionItem['tone'], string> = {
  alert: 'bg-alert/10 text-alert',
  warning: 'bg-warning/15 text-warning',
  info: 'bg-frost text-cerulean',
};

export function attentionIcon(key: string): string {
  return ATTENTION_ICON[key as AdminDashboardAttentionKey] ?? 'circle-alert';
}

export function attentionTint(tone: string): string {
  return ATTENTION_TINT[tone as AdminDashboardAttentionItem['tone']] ?? ATTENTION_TINT.info;
}

// ----- Dates & people -----

const DAY_LONG = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const DAY_SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' });
const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** A 'YYYY-MM-DD' calendar day as a local date (never shifted by the zone). */
function ymdDate(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** '2026-10-14' → "Wed 14 Oct". */
export function dayLabel(ymd: string): string {
  const d = ymdDate(ymd);
  return d ? DAY_LONG.format(d) : ymd;
}

/** '2026-10-14' → "14 Oct". */
export function dayShort(ymd: string): string {
  const d = ymdDate(ymd);
  return d ? DAY_SHORT.format(d) : ymd;
}

/** "10:30" in the viewer's zone. */
export function timeOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : TIME.format(d);
}

/** "10:30–11:00". */
export function timeRange(start: string, end: string | null | undefined): string {
  const a = timeOf(start);
  const b = timeOf(end);
  return b ? `${a}–${b}` : a;
}

/** "Wed 14 Oct 2026, 10:30" in the viewer's zone. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : DATE_TIME.format(d);
}

/** "in 25 min" / "in 1 h 10 min" / "now" until a start time. */
export function startsIn(iso: string, now = Date.now()): string {
  const mins = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (!Number.isFinite(mins) || mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h} h ${m} min` : `in ${h} h`;
}

/** "Dr. Grace Bell" → "GB". */
export function initials(name: string | null | undefined): string {
  return (name ?? '')
    .replace(/^(dr|prof)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/** 'super_admin' → "Super admin". */
export function roleLabel(role: string | null | undefined): string {
  const r = (role ?? '').replace(/[_-]+/g, ' ').trim();
  return r ? r[0].toUpperCase() + r.slice(1) : '';
}

/** The icon for an audit event, from its action's area. */
export function activityIcon(action: string): string {
  const area = action.split('.')[0];
  switch (area) {
    case 'specialist':
    case 'signature':
      return 'stethoscope';
    case 'appointment':
      return 'calendar-check';
    case 'call':
    case 'recording':
      return 'video';
    case 'consent':
      return 'shield-check';
    case 'note':
    case 'care_plan':
    case 'copilot':
    case 'certificate':
    case 'referral':
      return 'file-text';
    case 'prescription':
      return 'pill';
    case 'lab_order':
      return 'flask-conical';
    case 'wallet':
      return 'wallet';
    case 'payment':
      return 'credit-card';
    case 'payout':
      return 'banknote';
    case 'support':
    case 'ticket':
      return 'headphones';
    case 'staff':
    case 'user':
    case 'auth':
      return 'user';
    case 'settings':
    case 'pricing':
    case 'reference':
      return 'settings';
    default:
      return 'activity';
  }
}

/** The greeting in the page header, by the viewer's local hour. */
export function greeting(name: string, hour = new Date().getHours()): string {
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = name.split(/\s+/).filter(Boolean)[0] ?? '';
  return first ? `${part}, ${first}` : part;
}
