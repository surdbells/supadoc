import { ymdInZone } from '@supadoc/data-access';
import type {
  CredentialStatus,
  CredentialType,
  DoctorLoginStateDto,
  LicenceRoute,
  LicenceStateDto,
  LicenceStatus,
  OnboardingItemKey,
  SpecialistDetailDto,
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

/**
 * The generic look (fields, buttons, cards, pills) lives in the back office's
 * one layout module (shared/layout.ts); re-exported here so the specialist
 * screens keep importing it from one place.
 */
export {
  BTN_DANGER,
  BTN_DANGER_OUTLINE,
  BTN_GHOST,
  BTN_PRIMARY,
  BTN_SECONDARY,
  BTN_SUCCESS,
  CARD,
  FIELD,
  FIELD_INVALID,
  FOCUS_RING,
  LABEL,
  PILL,
} from '../shared/layout';

/** The onboarding checklist, in the order a doctor works through it (a doctor licensed in Nigeria). */
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

/**
 * How a doctor's licensing reads. Doctors licensed in Nigeria hold an MDCN
 * number, the MDCN full-registration certificate and an annual practising
 * licence; doctors licensed abroad hold a registration with their own
 * regulator, a Certificate of Good Standing and a practising licence (the
 * API's `Specialist::licence_route`, `registrationLabel()`).
 */
export interface LicenceWording {
  readonly abroad: boolean;
  /** "MDCN", or the regulator's name ("General Medical Council"). */
  readonly regulator: string;
  /** "MDCN number" / "General Medical Council number" (or "Registration number"). */
  readonly numberLabel: string;
  /** "the MDCN register" / "the General Medical Council register". */
  readonly registerName: string;
  /** The document in place of the MDCN full-registration certificate. */
  readonly registrationDoc: string;
  readonly registrationType: CredentialType;
  /** The practising licence. */
  readonly licenceDoc: string;
  readonly licenceType: CredentialType;
}

/** Both licence types: a licence needs a number and an expiry, and decides the licence in force. */
export const LICENCE_TYPES: readonly CredentialType[] = ['annual_practising_licence', 'foreign_practising_licence'];

export function licenceWording(route: LicenceRoute | null | undefined, regulatorName?: string | null): LicenceWording {
  if (route !== 'abroad') {
    return {
      abroad: false,
      regulator: 'MDCN',
      numberLabel: 'MDCN number',
      registerName: 'the MDCN register',
      registrationDoc: 'MDCN full-registration certificate',
      registrationType: 'mdcn_full_registration',
      licenceDoc: 'Annual practising licence',
      licenceType: 'annual_practising_licence',
    };
  }
  const name = (regulatorName ?? '').trim();
  return {
    abroad: true,
    regulator: name || 'their regulator',
    numberLabel: name ? `${name} number` : 'Registration number',
    registerName: name ? `the ${name} register` : "the regulator's register",
    registrationDoc: 'Certificate of Good Standing',
    registrationType: 'good_standing_certificate',
    licenceDoc: 'Practising licence',
    licenceType: 'foreign_practising_licence',
  };
}

/** The wording for a doctor page (the onboarding payload's route, else the profile's). */
export function doctorLicenceWording(d: SpecialistDetailDto): LicenceWording {
  return licenceWording(
    d.licence_route ?? d.profile?.licence_route,
    d.registration?.regulator_name ?? d.profile?.regulator_name,
  );
}

/** The doctor's registration number: the MDCN number, or the one with their regulator abroad. */
export function registrationNumber(d: SpecialistDetailDto): string | null {
  if (!doctorLicenceWording(d).abroad) return d.profile?.mdcn_number ?? null;
  return d.registration?.registration_number ?? d.profile?.registration_number ?? null;
}

/** The checklist with the route's licensing items. */
export function checklistFor(w: LicenceWording): readonly { key: OnboardingItemKey; label: string }[] {
  if (!w.abroad) return CHECKLIST;
  const abroad: Partial<Record<OnboardingItemKey, string>> = {
    mdcn: 'Licence or registration number',
    mdcn_certificate: 'Certificate of Good Standing',
    practising_licence: 'Practising licence',
  };
  return CHECKLIST.map((c) => ({ key: c.key, label: abroad[c.key] ?? c.label }));
}

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
      return { label: 'Approved', icon: 'badge-check', cls: 'bg-sage/15 text-sage-ink' };
    case 'pending_review':
      return { label: 'Needs review', icon: 'list-checks', cls: 'bg-warning/15 text-ink' };
    case 'rejected':
      return { label: 'Rejected', icon: 'undo-2', cls: 'bg-alert/10 text-alert-ink' };
    case 'suspended':
      return { label: 'Suspended', icon: 'ban', cls: 'bg-alert/10 text-alert-ink' };
    default:
      return { label: 'Onboarding', icon: 'user-plus', cls: 'bg-frost text-cerulean-dark' };
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
      cls: 'bg-frost text-cerulean-dark',
    };
  }
  return { label: 'Invite expired', icon: 'mail', cls: 'bg-warning/15 text-ink' };
}

export function licenceBadge(status: LicenceStatus, expiresAt: string | null | undefined): Badge {
  switch (status) {
    case 'valid':
      return { label: `Licence valid to ${calendarDay(expiresAt)}`, icon: 'shield-check', cls: 'bg-sage/10 text-sage-ink' };
    case 'expiring':
      return { label: `Licence expires ${calendarDay(expiresAt)}`, icon: 'hourglass', cls: 'bg-warning/15 text-ink' };
    case 'expired':
      return { label: `Licence expired ${calendarDay(expiresAt)}`, icon: 'shield-alert', cls: 'bg-alert/10 text-alert-ink' };
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
      return { label: 'Verified', icon: 'badge-check', cls: 'bg-sage/15 text-sage-ink' };
    case 'rejected':
      return { label: 'Rejected', icon: 'circle-x', cls: 'bg-alert/10 text-alert-ink' };
    case 'expired':
      return { label: 'Expired', icon: 'shield-alert', cls: 'bg-alert/10 text-alert-ink' };
    default:
      return { label: 'Replaced', icon: 'history', cls: 'bg-cloud text-slate' };
  }
}

/** Appointment badges follow the back office's one appointment mapping (incl. `missed`). */
export { appointmentStatusClass } from '../shared/appointment-status';

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
