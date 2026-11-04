import type {
  ApplicationDocumentDto,
  ApplicationDocumentSlot,
  ApplicationInfoRequestDto,
  DoctorApplicationDetailDto,
  DoctorApplicationEventKind,
  DoctorApplicationFilter,
  DoctorApplicationQueueDto,
  DoctorApplicationSort,
  DoctorApplicationStatus,
  LicenceRoute,
} from '@supadoc/models';
import {
  CLINIC_TIME_ZONE,
  formatInZone,
  isoToZonedLocal,
  isValidTimeZone,
  offsetsDiffer,
  viewerTimeZone,
  whenLabel,
  zoneAbbr,
  zonedLocalToIso,
} from '@supadoc/data-access';
import type { Badge } from '../specialists/specialist-ui';

/**
 * Shared look and wording for the back office's doctor-application screens
 * (list, detail, tabs and dialogs). Every state reads as icon + words, never
 * colour alone. Interview times are said in clinic time (Lagos, WAT), with the
 * applicant's time (their `personal.time_zone`) and the viewer's own time
 * beside them when they differ.
 */

/** The detail page's tabs (`?tab=`). */
export type ApplicationTab = 'application' | 'documents' | 'timeline' | 'notes';

/** Lagos never changes its clock: West Africa Time all year. */
export const CLINIC_ZONE_LABEL = 'WAT';

const STATUS_BADGES: Record<DoctorApplicationStatus, Badge> = {
  draft: { label: 'Draft', icon: 'file-text', cls: 'bg-cloud text-slate' },
  submitted: { label: 'New', icon: 'send', cls: 'bg-frost text-cerulean-dark' },
  under_review: { label: 'Under review', icon: 'search-check', cls: 'bg-cerulean/10 text-cerulean-dark' },
  more_info_needed: { label: 'More info needed', icon: 'message-square', cls: 'bg-warning/15 text-ink' },
  interview_scheduled: { label: 'Interview scheduled', icon: 'video', cls: 'bg-teal/10 text-teal-ink' },
  approved: { label: 'Approved', icon: 'badge-check', cls: 'bg-sage/15 text-sage-ink' },
  rejected: { label: 'Rejected', icon: 'circle-x', cls: 'bg-alert/10 text-alert-ink' },
  withdrawn: { label: 'Withdrawn', icon: 'undo-2', cls: 'bg-cloud text-slate' },
};

export function applicationStatusBadge(status: DoctorApplicationStatus | null | undefined): Badge {
  return STATUS_BADGES[status ?? 'submitted'] ?? STATUS_BADGES.submitted;
}

/** "Nigeria · MDCN" or "Abroad · United Kingdom" (the API's label when it sends one). */
export function routeBadge(route: LicenceRoute, label?: string | null): Badge {
  const text = (label ?? '').trim() || (route === 'abroad' ? 'Abroad' : 'Nigeria · MDCN');
  return route === 'abroad'
    ? { label: text, icon: 'globe', cls: 'bg-glacier text-ink' }
    : { label: text, icon: 'id-card', cls: 'bg-glacier text-ink' };
}

/** The "Needs action" tag on a row or header. */
export const NEEDS_ACTION_BADGE: Badge = { label: 'Needs action', icon: 'circle-alert', cls: 'bg-warning/15 text-ink' };

// ----- List: filters, sorts, route -----

export interface ApplicationFilterDef {
  readonly value: DoctorApplicationFilter;
  readonly label: string;
  /** Which queue count the chip shows. */
  readonly count?: keyof DoctorApplicationQueueDto;
  /** Highlighted while its count is above zero. */
  readonly attention?: boolean;
}

export const APPLICATION_FILTERS: readonly ApplicationFilterDef[] = [
  { value: 'all', label: 'All' },
  { value: 'needs_action', label: 'Needs action', count: 'needs_action', attention: true },
  { value: 'submitted', label: 'New', count: 'submitted' },
  { value: 'under_review', label: 'Under review', count: 'under_review' },
  { value: 'more_info_needed', label: 'More info needed', count: 'more_info_needed' },
  { value: 'interview_scheduled', label: 'Interview scheduled', count: 'interview_scheduled' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

export const APPLICATION_SORTS: readonly { value: DoctorApplicationSort; label: string }[] = [
  { value: 'waiting', label: 'Waiting longest' },
  { value: 'newest', label: 'Newest' },
  { value: 'interview', label: 'Interview date' },
];

/** The API's default sort for a filter: the queue is worked oldest first. */
export function defaultSort(filter: DoctorApplicationFilter): DoctorApplicationSort {
  return filter === 'needs_action' ? 'waiting' : 'newest';
}

export const ROUTE_OPTIONS: readonly { value: LicenceRoute | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'ng', label: 'Nigeria' },
  { value: 'abroad', label: 'Abroad' },
];

// ----- Sections and documents -----

/** The sections a reviewer can ask the applicant to change (consent is never re-opened). */
export const REQUESTABLE_SECTIONS: readonly { key: 'personal' | 'professional' | 'licence' | 'qualifications' | 'indemnity'; label: string }[] = [
  { key: 'personal', label: 'Personal details' },
  { key: 'professional', label: 'Professional details' },
  { key: 'licence', label: 'Licence' },
  { key: 'qualifications', label: 'Qualifications' },
  { key: 'indemnity', label: 'Indemnity' },
];

/** The document slots of a route, in the order the applicant uploads them (§2.12). */
export function routeSlots(route: LicenceRoute): Exclude<ApplicationDocumentSlot, 'additional'>[] {
  return [
    route === 'abroad' ? 'good_standing_certificate' : 'mdcn_certificate',
    'government_id',
    'medical_degree',
    'practising_licence',
    'curriculum_vitae',
    'indemnity_certificate',
  ];
}

const SLOT_LABELS: Record<Exclude<ApplicationDocumentSlot, 'practising_licence' | 'additional'>, string> = {
  mdcn_certificate: 'MDCN full registration certificate',
  good_standing_certificate: 'Certificate of Good Standing',
  government_id: 'Government-issued ID',
  medical_degree: 'Medical degree certificate',
  curriculum_vitae: 'Curriculum vitae',
  indemnity_certificate: 'Indemnity certificate',
};

/** A slot's name for the route (the API sends `slot_label` on documents; this is for slots with none yet). */
export function slotLabel(slot: ApplicationDocumentSlot, route: LicenceRoute): string {
  if (slot === 'practising_licence') return route === 'abroad' ? 'Current practising licence' : 'Current MDCN practising licence';
  if (slot === 'additional') return 'Another document';
  return SLOT_LABELS[slot];
}

/** What a document is called: the reviewer's own words for an extra one. */
export function documentTitle(doc: Pick<ApplicationDocumentDto, 'slot' | 'slot_label' | 'label'>): string {
  return doc.slot === 'additional' && doc.label ? doc.label : doc.slot_label;
}

export function documentSourceBadge(doc: Pick<ApplicationDocumentDto, 'uploaded_during'>): Badge {
  return doc.uploaded_during === 'info_response'
    ? { label: 'Sent after request', icon: 'message-square', cls: 'bg-frost text-cerulean-dark' }
    : { label: 'With application', icon: 'clipboard-list', cls: 'bg-glacier text-slate' };
}

// ----- Timeline -----

const EVENT_ICONS: Record<DoctorApplicationEventKind, string> = {
  submitted: 'send',
  review_started: 'search-check',
  info_requested: 'message-square',
  info_item_updated: 'upload',
  applicant_replied: 'send',
  interview_scheduled: 'calendar-plus',
  interview_rescheduled: 'calendar-clock',
  interview_cancelled: 'calendar-x',
  interview_resent: 'mail',
  approved: 'badge-check',
  rejected: 'circle-x',
  withdrawn: 'undo-2',
  specialist_created: 'user-plus',
  email_sent: 'mail',
  sms_sent: 'phone',
  notification_failed: 'circle-alert',
};

export function eventIcon(kind: DoctorApplicationEventKind): string {
  return EVENT_ICONS[kind] ?? 'history';
}

/** Emails, texts and failed sends: the notification trail (can be hidden on the Timeline). */
export function isNotificationEvent(kind: DoctorApplicationEventKind): boolean {
  return kind === 'email_sent' || kind === 'sms_sent' || kind === 'notification_failed';
}

// ----- People and places -----

let regionNames: Intl.DisplayNames | null | undefined;

/** An ISO 3166-1 code as its English name ("GB" → "United Kingdom"); the code itself when unknown. */
export function countryName(iso: string | null | undefined): string {
  const code = (iso ?? '').trim().toUpperCase();
  if (!code) return '—';
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export function genderLabel(g: string | null | undefined): string {
  if (g === 'male') return 'Male';
  if (g === 'female') return 'Female';
  if (g === 'prefer_not_to_say') return 'Prefer not to say';
  return '—';
}

/**
 * Since when the application has waited for staff: the applicant's latest
 * reply to a request, else the submission (the API's `waiting` sort).
 */
export function waitingSince(d: Pick<DoctorApplicationDetailDto, 'submitted_at' | 'info_requests'>): string {
  let since = d.submitted_at;
  for (const r of d.info_requests ?? []) {
    if (r.responded_at && r.responded_at > since) since = r.responded_at;
  }
  return since;
}

/** "Waiting 3 days" (whole days; under a day reads "Waiting since today"). */
export function waitingLabel(sinceIso: string | null | undefined, now: Date = new Date()): string {
  const at = sinceIso ? new Date(sinceIso).getTime() : NaN;
  if (isNaN(at)) return '';
  const days = Math.floor((now.getTime() - at) / 86_400_000);
  if (days < 1) return 'Waiting since today';
  return `Waiting ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** The open info request (unanswered, not closed), if any. */
export function openInfoRequest(requests: readonly ApplicationInfoRequestDto[] | null | undefined): ApplicationInfoRequestDto | null {
  return (requests ?? []).find((r) => !r.responded_at && !r.closed_at) ?? null;
}

export const CLOSE_REASON_LABELS: Record<NonNullable<ApplicationInfoRequestDto['close_reason']>, string> = {
  staff_resumed: 'Closed when the review resumed',
  rejected: 'Closed when the application was rejected',
  withdrawn: 'Closed when the applicant withdrew',
};

// ----- Meeting links -----

/**
 * The host of an interview link the API accepts (https, a dotted host, no user
 * or password, ≤500 characters) — null for anything else.
 */
export function meetingHost(url: string | null | undefined): string | null {
  const raw = (url ?? '').trim();
  if (!raw || raw.length > 500) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  return parsed.hostname.includes('.') ? parsed.hostname : null;
}

// ----- Clinic time -----
// Built on the shared zone helpers (`@supadoc/data-access` time-zone): labels
// come from numbers and fixed English names, so they match the API's emails.

/** A valid instant, or null. */
function instant(iso: string | null | undefined): Date | null {
  const at = iso ? new Date(iso) : null;
  return at && !isNaN(at.getTime()) ? at : null;
}

/** "Wed 14 Oct, 10:00" on `tz`'s clock (24-hour, as the applicant's SMS and the clinic say it). */
function dayHm(at: Date, tz: string): string {
  return `${formatInZone(at, tz, 'date').replace(/ \d+$/, '')}, ${formatInZone(at, tz, 'hm')}`;
}

/**
 * A `datetime-local` value read as clinic (Lagos) wall time → ISO 8601 with the
 * zone's offset for that date, e.g. "2026-10-14T10:00" → "2026-10-14T10:00:00+01:00".
 * The API refuses a time without an offset (it would read it as server time).
 */
export function clinicLocalToIso(local: string, tz: string = CLINIC_TIME_ZONE): string | null {
  // Seconds and beyond (a datetime-local with a small step) are dropped: interviews start on the minute.
  const m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec((local ?? '').trim());
  return m ? zonedLocalToIso(m[0], tz) : null;
}

/** An instant as a `datetime-local` value on the clinic's clock ("2026-10-14T10:00"). */
export function isoToClinicLocal(iso: string | null | undefined, tz: string = CLINIC_TIME_ZONE): string {
  return instant(iso) ? isoToZonedLocal(iso as string, tz) : '';
}

/** "Wed 14 Oct, 10:00 WAT" — the clinic time every applicant is given. */
export function clinicDateTime(iso: string | null | undefined): string {
  const at = instant(iso);
  return at ? `${dayHm(at, CLINIC_TIME_ZONE)} ${CLINIC_ZONE_LABEL}` : '—';
}

/** The same instant on the viewer's own clock, with its zone ("Wed 14 Oct, 05:00 EDT"). */
export function viewerDateTime(iso: string | null | undefined, tz: string = viewerTimeZone()): string {
  const at = instant(iso);
  return at ? `${dayHm(at, tz)} ${zoneAbbr(tz, at)}` : '—';
}

/** Whether the viewer's clock reads differently from the clinic's at that instant. */
export function viewerTimeDiffers(iso: string | null | undefined, tz: string = viewerTimeZone()): boolean {
  const at = instant(iso);
  return !!at && offsetsDiffer(at, tz, CLINIC_TIME_ZONE);
}

/**
 * The interview on the applicant's own clock, "Wed 14 Oct, 4:00 AM CDT
 * (America/Chicago)" — only when they gave a zone (`personal.time_zone`) and
 * it is on a different offset from the clinic's at that instant; else null.
 */
export function applicantDateTime(iso: string | null | undefined, applicantTz: string | null | undefined): string | null {
  const at = instant(iso);
  if (!at || !isValidTimeZone(applicantTz) || !offsetsDiffer(at, applicantTz, CLINIC_TIME_ZONE)) return null;
  return `${whenLabel(at, applicantTz)} (${applicantTz})`;
}
