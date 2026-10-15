import { ymdInZone } from '@supadoc/data-access';
import type {
  CredentialStatus,
  DoctorLoginStateDto,
  LicenceStateDto,
  LicenceStatus,
  OnboardingItemKey,
  SpecialistStatus,
} from '@supadoc/models';

/**
 * Shared look and wording for the back office's specialist screens (list,
 * doctor page and its tabs). Every state reads as icon + words, never colour
 * alone; dates and times are shown in the viewer's own time zone.
 */

/** The doctor page's tabs (`?tab=`). */
export type DoctorTab = 'overview' | 'credentials' | 'review' | 'appointments' | 'earnings' | 'reviews' | 'history';

export interface Badge {
  readonly label: string;
  readonly icon: string;
  readonly cls: string;
}

export const FOCUS_RING = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40';

export const FIELD =
  'w-full min-w-0 rounded-field border border-cloud bg-white px-3 py-2.5 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20 disabled:bg-glacier disabled:text-slate';

export const FIELD_INVALID = '!border-alert focus:!ring-alert/20';

export const LABEL = 'font-sans text-caption font-semibold text-slate';

export const BTN_PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:cursor-not-allowed disabled:opacity-60 ' +
  FOCUS_RING;

export const BTN_SUCCESS =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field bg-sage px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60 ' +
  FOCUS_RING;

export const BTN_DANGER =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field bg-alert px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-alert/90 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-alert/40';

export const BTN_SECONDARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field border border-cloud bg-white px-4 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:cursor-not-allowed disabled:opacity-60 ' +
  FOCUS_RING;

export const BTN_DANGER_OUTLINE =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field border border-alert/40 bg-white px-4 py-2.5 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-alert/40';

export const BTN_GHOST =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field px-4 py-2.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:bg-glacier hover:text-ink disabled:opacity-60 ' +
  FOCUS_RING;

export const CARD = 'rounded-card border border-cloud bg-white';

export const PILL = 'inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold';

/** The onboarding checklist, in the order a doctor works through it. */
export const CHECKLIST: readonly { key: OnboardingItemKey; label: string }[] = [
  { key: 'photo', label: 'Profile photo' },
  { key: 'bio', label: 'Bio' },
  { key: 'qualifications', label: 'Qualifications' },
  { key: 'mdcn', label: 'MDCN registration number' },
  { key: 'mdcn_certificate', label: 'MDCN full-registration certificate' },
  { key: 'practising_licence', label: 'Annual practising licence' },
  { key: 'signature', label: 'Signature' },
  { key: 'availability', label: 'Availability (weekly hours or open slots)' },
  { key: 'payout', label: 'Payout account' },
  { key: 'terms', label: 'Practitioner terms accepted' },
];

/** Mirrors the API's SpecialistSuspensionService::CODES (the preview sends the live list). */
export const SUSPENSION_CODE_LABELS: Record<string, string> = {
  licence_expired: 'Practising licence expired',
  conduct: 'Professional conduct concern',
  complaint: 'Complaint under review',
  admin: 'Administrative',
  other: 'Other',
};

export function codeLabel(code: string | null | undefined): string {
  if (!code) return '';
  return SUSPENSION_CODE_LABELS[code] ?? code.replace(/_/g, ' ');
}

export function statusBadge(status: SpecialistStatus | null | undefined): Badge {
  switch (status ?? 'approved') {
    case 'approved':
      return { label: 'Approved', icon: 'badge-check', cls: 'bg-sage/15 text-sage' };
    case 'pending_review':
      return { label: 'Needs review', icon: 'list-checks', cls: 'bg-warning/15 text-ink' };
    case 'rejected':
      return { label: 'Rejected', icon: 'undo-2', cls: 'bg-alert/10 text-alert' };
    case 'suspended':
      return { label: 'Suspended', icon: 'ban', cls: 'bg-alert/10 text-alert' };
    default:
      return { label: 'Onboarding', icon: 'user-plus', cls: 'bg-frost text-cerulean' };
  }
}

export function loginBadge(l: DoctorLoginStateDto | null | undefined): Badge {
  if (!l) return { label: 'No login yet', icon: 'user', cls: 'bg-glacier text-slate' };
  if (!l.active) return { label: 'Login deactivated', icon: 'user-x', cls: 'bg-cloud text-slate' };
  if (l.password_set) return { label: 'Login active', icon: 'user-check', cls: 'bg-glacier text-ink' };
  if (l.invite_pending) {
    return {
      label: 'Invite sent' + (l.invite_expires_at ? ` · expires ${dateOnly(l.invite_expires_at)}` : ''),
      icon: 'mail',
      cls: 'bg-frost text-cerulean',
    };
  }
  return { label: 'Invite expired', icon: 'mail', cls: 'bg-warning/15 text-ink' };
}

export function licenceBadge(status: LicenceStatus, expiresAt: string | null | undefined): Badge {
  switch (status) {
    case 'valid':
      return { label: `Licence valid to ${calendarDay(expiresAt)}`, icon: 'shield-check', cls: 'bg-sage/10 text-sage' };
    case 'expiring':
      return { label: `Licence expires ${calendarDay(expiresAt)}`, icon: 'hourglass', cls: 'bg-warning/15 text-ink' };
    case 'expired':
      return { label: `Licence expired ${calendarDay(expiresAt)}`, icon: 'shield-alert', cls: 'bg-alert/10 text-alert' };
    default:
      return { label: 'No licence on file', icon: 'shield-alert', cls: 'bg-glacier text-slate' };
  }
}

export function licenceStateBadge(l: LicenceStateDto | null | undefined): Badge {
  return licenceBadge(l?.status ?? 'missing', l?.expires_at);
}

export function credentialBadge(status: CredentialStatus): Badge {
  switch (status) {
    case 'pending':
      return { label: 'Waiting for review', icon: 'hourglass', cls: 'bg-warning/15 text-ink' };
    case 'verified':
      return { label: 'Verified', icon: 'badge-check', cls: 'bg-sage/15 text-sage' };
    case 'rejected':
      return { label: 'Rejected', icon: 'circle-x', cls: 'bg-alert/10 text-alert' };
    case 'expired':
      return { label: 'Expired', icon: 'shield-alert', cls: 'bg-alert/10 text-alert' };
    default:
      return { label: 'Replaced', icon: 'history', cls: 'bg-cloud text-slate' };
  }
}

export function appointmentStatusClass(status: string): string {
  switch (status) {
    case 'confirmed':
    case 'completed':
      return 'bg-sage/15 text-sage';
    case 'cancelled':
      return 'bg-alert/10 text-alert';
    case 'rescheduled':
      return 'bg-cloud text-slate';
    case 'proposed':
      return 'bg-teal/10 text-teal';
    default:
      return 'bg-warning/15 text-ink';
  }
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const DAY_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const CALENDAR_DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** An instant shown as a day in the viewer's zone, e.g. "7 Oct 2026". */
export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : DAY.format(d);
}

/** An instant with its time, in the viewer's zone. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : DAY_TIME.format(d);
}

/** A 'YYYY-MM-DD' calendar day (licence expiry and the like), without any zone shift. */
export function calendarDay(ymd: string | null | undefined): string {
  const m = ymd ? /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd) : null;
  if (!m) return '—';
  return CALENDAR_DAY.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

/**
 * The clinic's zone — the API's ClinicTime (APP_TIMEZONE, default
 * Africa/Lagos), which decides when a licence or document has expired.
 */
export const CLINIC_TIME_ZONE = 'Africa/Lagos';

/**
 * Today as 'YYYY-MM-DD' on the clinic's calendar — the day the API checks
 * licence and document expiry against, so a reviewer elsewhere near midnight
 * sees the same verdict the server will give.
 */
export function clinicTodayYmd(at: Date = new Date()): string {
  return ymdInZone(at, CLINIC_TIME_ZONE);
}

export function money(amount: string | number | null | undefined, currency = 'NGN'): string {
  const n = Number(amount);
  if (amount === null || amount === undefined || amount === '' || isNaN(n)) return '—';
  try {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency: currency || 'NGN', maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

export function fileSize(bytes: number | null | undefined): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function initials(name: string | null | undefined): string {
  return (name ?? '')
    .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}
