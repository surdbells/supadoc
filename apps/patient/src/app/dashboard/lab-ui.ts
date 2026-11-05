/**
 * Laboratory & Diagnostics (lab requests) — the patient's pure helpers: the
 * status chip and helper line of every request (spec §4.2), priorities,
 * calendar dates, the timeline, the per-result captions and the upload rules.
 *
 * Rules these helpers keep:
 *  - The patient never sees a review outcome: there is no "abnormal" or
 *    "normal" here (the API never sends one). A reviewed request reads
 *    "Reviewed by your doctor" in one neutral tone (frost), never a success
 *    green that would hint "all clear".
 *  - Calendar dates (`valid_until`, `lab_date`, a support-reported
 *    `sample_date`) are printed from their `Y-m-d` parts, never through
 *    `new Date('Y-m-d')` or a zone: the same date the PDF and the emails print.
 *  - Instants are shown in the device zone (`formatInZone`).
 *  - Status is never colour alone: every chip is an icon and a word.
 */
import { fileExtension, formatInZone } from '@supadoc/data-access';
import type {
  LabEventType,
  LabItemKind,
  LabPriority,
  LabRequestStatus,
  LabShareOutcome,
  PatientLabRequestDto,
  PatientLabRequestSummaryDto,
  PatientLabResultDto,
} from '@supadoc/models';
import { cap, drName } from './document-sharing';

// ---------------------------------------------------------------------------
// Status chips (§4.2)
// ---------------------------------------------------------------------------

export interface LabChip {
  readonly label: string;
  readonly icon: string;
  /** Portal classes (all remapped for dark mode in styles.css). */
  readonly cls: string;
}

const ACTION: LabChip = {
  label: 'Action needed',
  icon: 'circle-alert',
  cls: 'bg-warning/10 text-warning-ink',
};
const ACCEPTED: LabChip = {
  label: 'Accepted',
  icon: 'circle-check',
  cls: 'bg-frost/60 text-cerulean-dark',
};
const SAMPLE: LabChip = {
  label: 'Sample given',
  icon: 'hourglass',
  cls: 'bg-teal/10 text-teal-ink',
};
const UPLOADED: LabChip = {
  label: 'Result uploaded',
  icon: 'file-text',
  cls: 'bg-sage/10 text-sage-ink',
};
/** One neutral tone for every reviewed request (never green: it would hint "all clear"). */
const REVIEWED: LabChip = {
  label: 'Reviewed by your doctor',
  icon: 'stethoscope',
  cls: 'bg-frost/60 text-cerulean-dark',
};
const DECLINED: LabChip = {
  label: 'Declined',
  icon: 'circle-x',
  cls: 'bg-cloud text-slate',
};
const CANCELLED: LabChip = {
  label: 'Cancelled by your doctor',
  icon: 'circle-x',
  cls: 'bg-cloud text-slate',
};
const EXPIRED: LabChip = {
  label: 'Expired',
  icon: 'hourglass',
  cls: 'bg-cloud text-slate',
};

/** What a request's chip and helper are read from (a list row or the detail). */
export type LabChipInput = Pick<
  PatientLabRequestSummaryDto,
  'status' | 'reviewed' | 'awaiting_review' | 'results_count'
>;

/** The chip of a request (icon + text). */
export function labChip(r: LabChipInput): LabChip {
  switch (r.status) {
    case 'awaiting_consent':
      return ACTION;
    case 'booked':
      return ACCEPTED;
    case 'in_lab':
      return SAMPLE;
    case 'result_ready':
      return r.reviewed ? REVIEWED : UPLOADED;
    case 'declined':
      return DECLINED;
    case 'cancelled':
      return CANCELLED;
    case 'expired':
      return EXPIRED;
    default:
      return ACTION;
  }
}

/** The line under a chip ('' when there is none). `doctorName` as the API gives it. */
export function labHelper(
  r: LabChipInput,
  doctorName: string | null | undefined,
): string {
  switch (r.status) {
    case 'awaiting_consent':
      return 'Review and accept this request';
    case 'booked':
      return 'Take this request to a lab';
    case 'in_lab':
      return 'Waiting for your results';
    case 'result_ready':
      return resultHelper(r, doctorName);
    case 'cancelled':
      // Cancelled after the sample: results can still come, and read as on a result-ready request.
      return r.results_count > 0 ? resultHelper(r, doctorName) : '';
    default:
      return '';
  }
}

function resultHelper(
  r: LabChipInput,
  doctorName: string | null | undefined,
): string {
  if (r.awaiting_review) return `Waiting for ${drName(doctorName)} to review`;
  if (r.reviewed) return "Open to read your doctor's note";
  return 'Open to see who can review it';
}

// ---------------------------------------------------------------------------
// Priority, counts and dates
// ---------------------------------------------------------------------------

const PRIORITY: Record<
  LabPriority,
  { readonly label: string; readonly detail: string }
> = {
  routine: { label: 'Routine', detail: 'Routine — results in 24 to 48 hours' },
  urgent: { label: 'Urgent', detail: 'Urgent — same day' },
  stat: { label: 'STAT', detail: 'STAT — most urgent' },
};

/** "Routine" / "Urgent" / "STAT". */
export function priorityLabel(p: LabPriority | null | undefined): string {
  return (p && PRIORITY[p]?.label) || PRIORITY.routine.label;
}

/** "Routine — results in 24 to 48 hours" / "Urgent — same day" / "STAT — most urgent". */
export function priorityDetail(p: LabPriority | null | undefined): string {
  return (p && PRIORITY[p]?.detail) || PRIORITY.routine.detail;
}

/** "1 test" / "3 tests". */
export function testsLabel(n: number): string {
  return n === 1 ? '1 test' : `${n} tests`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * A clinic calendar date `'Y-m-d'` as "4 Dec 2026", from its parts — no Date,
 * no zone, so it is the date the PDF, the emails and the doctor app print. ''
 * for anything else.
 */
export function calendarDate(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '');
  if (!m) return '';
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${day} ${MONTHS[month - 1]} ${m[1]}`;
}

/** An instant in `zone`: "Wed 4 Nov 2026" ('' when it can't be read). */
export function labDay(iso: string | null | undefined, zone: string): string {
  return iso ? formatInZone(iso, zone, 'date') : '';
}

/** An instant in `zone`: "Wed 4 Nov 2026, 4:30 PM" ('' when it can't be read). */
export function labDayTime(
  iso: string | null | undefined,
  zone: string,
): string {
  return iso ? formatInZone(iso, zone, 'dateTime') : '';
}

/** "Dr. Grace Bell" — the requesting doctor, as every sentence names them ("your doctor" without a name). */
export function labDoctor(
  r: Pick<PatientLabRequestSummaryDto, 'doctor'>,
): string {
  return drName(r.doctor?.name);
}

/** The same, starting a sentence ("Your doctor" without a name). */
export function labDoctorCap(
  r: Pick<PatientLabRequestSummaryDto, 'doctor'>,
): string {
  return cap(labDoctor(r));
}

// ---------------------------------------------------------------------------
// Tests requested
// ---------------------------------------------------------------------------

export type LabItem = PatientLabRequestDto['items'][number];

export interface LabItemGroup {
  readonly kind: LabItemKind;
  readonly title: string;
  readonly items: readonly LabItem[];
}

const KIND_TITLES: readonly (readonly [LabItemKind, string])[] = [
  ['lab', 'Laboratory'],
  ['imaging', 'Imaging'],
  ['physiological', 'Physiological'],
];

/** The request's items grouped as "Laboratory (n)", "Imaging (n)", "Physiological (n)" (empty groups left out). */
export function itemGroups(items: readonly LabItem[]): LabItemGroup[] {
  return KIND_TITLES.map(([kind, title]) => ({
    kind,
    title,
    items: items.filter((i) => i.kind === kind),
  })).filter((g) => g.items.length > 0);
}

/**
 * A specimen as it reads after another label: "Venous blood: serum" →
 * "Venous blood (serum)", "Venous blood: plasma (EDTA)" → "Venous blood
 * (plasma, EDTA)", so "Sample: …" never shows two colons. Others as given.
 */
export function specimenText(label: string): string {
  const m = /^([^:]+):\s*(.+)$/.exec(label.trim());
  if (!m) return label;
  const inner = m[2].replace(/\s*\(([^()]*)\)$/, ', $1');
  return `${m[1].trim()} (${inner})`;
}

/**
 * A request number cut after each hyphen ("GVM-", "REQ-", "20261105-",
 * "00001"), for a `<wbr>` after each part: browsers never break between a
 * hyphen and a digit, so a phone otherwise splits the digits ("…-0 / 0001").
 */
export function numberParts(n: string | null | undefined): string[] {
  return (n ?? '').match(/[^-]*-|[^-]+$/g) ?? [];
}

/** The caption under an item: "Sample: …" (lab), "Preparation: …" (imaging, unless none), else ''. */
export function itemCaption(i: LabItem): string {
  if (i.kind === 'lab')
    return i.specimen_label
      ? `Sample: ${specimenText(i.specimen_label)}`
      : '';
  if (
    i.kind === 'imaging' &&
    i.preparation_label &&
    i.preparation_code &&
    i.preparation_code !== 'none'
  ) {
    return `Preparation: ${i.preparation_label}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** "Covers: FBC, MP" — '' when the result covers every test of the request. */
export function coversLabel(
  res: Pick<PatientLabResultDto, 'item_ids'>,
  items: readonly LabItem[],
): string {
  const ids = new Set(res.item_ids ?? []);
  if (items.length === 0 || ids.size === 0 || items.every((i) => ids.has(i.id)))
    return '';
  const shorts = items
    .filter((i) => ids.has(i.id))
    .map((i) => i.short || i.label);
  return shorts.length ? `Covers: ${shorts.join(', ')}` : '';
}

/**
 * The one sharing caption of a result row (first match wins), or null: the
 * doctor isn't practising (the card's alert says so), private, shared but a
 * type they can't open, shared.
 */
export function resultCaption(
  r: Pick<PatientLabRequestDto, 'doctor' | 'doctor_available'>,
  res: PatientLabResultDto,
): string | null {
  if (!r.doctor_available) return null;
  const dr = labDoctor(r);
  if (!res.shared_now) {
    return `Private — ${cap(dr)} can see that you added a result, but not the file, so they can't review it.`;
  }
  if (!res.viewable) {
    const ext = (res.document?.extension || '').toUpperCase() || 'these';
    return `${cap(dr)} can't open ${ext} files. Add the result as a PDF or photo.`;
  }
  return `Shared with ${dr}`;
}

/**
 * The upload dialog's "Share this result with …" default: on while the
 * request's results grant is active, or before any grant when the patient
 * agreed to share at acceptance. A patient who stopped sharing (`ended`)
 * starts unticked.
 */
export function shareDefault(
  r: Pick<PatientLabRequestDto, 'results_sharing' | 'consent'>,
): boolean {
  return (
    r.results_sharing === 'active' ||
    (r.results_sharing === 'none' && !!r.consent?.share_results)
  );
}

/** What the page says once a result is added, by the server's `share_outcome`. */
export function uploadOutcomeMessage(
  outcome: LabShareOutcome,
  doctorName: string | null | undefined,
): string {
  const dr = drName(doctorName);
  switch (outcome) {
    case 'shared':
      return `Result added. ${cap(dr)} can now see it.`;
    case 'private':
      return `Result added. It's private — ${dr} can't see it.`;
    case 'sharing_unavailable':
      return `Result added. Sharing is unavailable right now, so ${dr} can't see it. You can share it from Documents later.`;
    case 'doctor_unavailable':
      return `Result added. ${cap(dr)} isn't available on VideoMed right now, so the file stays private.`;
    default:
      return 'Result added.';
  }
}

// ---------------------------------------------------------------------------
// Result files (E13)
// ---------------------------------------------------------------------------

/** The file picker's accept list (PDF, photos, DICOM, Word). */
export const LAB_RESULT_ACCEPT =
  '.pdf,.jpg,.jpeg,.png,.webp,.dcm,.docx,application/pdf,image/jpeg,image/png,image/webp,application/dicom,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const LAB_RESULT_EXTENSIONS: readonly string[] = [
  'pdf',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'dcm',
  'docx',
];
export const LAB_RESULT_MAX_BYTES = 10 * 1024 * 1024;
/** At most this many result files on one request. */
export const LAB_MAX_RESULTS = 10;
/** The API's own messages (MedicalDocumentStorage / UploadLabResultAction). */
export const LAB_FILE_TYPE_ERROR =
  'Upload a PDF, photo (JPG, PNG, WEBP), DICOM (.dcm) or Word file.';
export const LAB_FILE_SIZE_ERROR = 'File must be 10MB or smaller';
export const LAB_FILE_EMPTY_ERROR = 'The file is empty';

/** Why a picked file can't be a result ('' when it can). */
export function resultFileError(file: Pick<File, 'name' | 'size'>): string {
  if (!LAB_RESULT_EXTENSIONS.includes(fileExtension(file.name)))
    return LAB_FILE_TYPE_ERROR;
  if (file.size > LAB_RESULT_MAX_BYTES) return LAB_FILE_SIZE_ERROR;
  if (file.size <= 0) return LAB_FILE_EMPTY_ERROR;
  return '';
}

/** "212KB" / "1.4MB" for a picked file. */
export function fileSizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

// ---------------------------------------------------------------------------
// Timeline (§4.4 section 6)
// ---------------------------------------------------------------------------

export interface LabTimelineStep {
  readonly key: string;
  readonly label: string;
  /** When it happened, in the device zone ('' for a step not reached yet). */
  readonly at: string;
  readonly done: boolean;
  /** Extra line (a support-reported sample date). */
  readonly note?: string;
}

const MAIN_PATH: readonly (readonly [LabEventType, string])[] = [
  ['accepted', 'You accepted'],
  ['sample_given', 'You gave your sample'],
  ['result_added', 'Result added'],
  ['result_reviewed', 'Reviewed by your doctor'],
];

/** Where the steps still to come start, by status (an index into MAIN_PATH). */
const PENDING_FROM: Partial<Record<LabRequestStatus, number>> = {
  awaiting_consent: 0,
  booked: 1,
  in_lab: 2,
  result_ready: 3,
};

const TERMINAL_EVENT: Partial<Record<LabRequestStatus, LabEventType>> = {
  declined: 'declined',
  cancelled: 'cancelled',
  expired: 'expired',
};

/**
 * The request's history, oldest first, then the steps still to come (muted;
 * only while the request is open). Reminders are left out; a support
 * correction reads "Updated by VideoMed support".
 */
export function labTimeline(
  r: Pick<
    PatientLabRequestDto,
    'status' | 'doctor' | 'timeline' | 'expired_at' | 'expires_at' | 'sent_at'
  >,
  zone: string,
): LabTimelineStep[] {
  const dr = labDoctor(r);
  const steps: LabTimelineStep[] = [];
  const seen = new Set<LabEventType>();
  const label: Partial<Record<LabEventType, string>> = {
    sent: `Sent by ${dr}`,
    accepted: 'You accepted',
    declined: 'You declined',
    sample_given: 'You gave your sample',
    result_added: 'Result added',
    result_reviewed: 'Reviewed by your doctor',
    cancelled: 'Cancelled by your doctor',
    expired: 'Expired',
    status_corrected: 'Updated by VideoMed support',
  };
  (r.timeline ?? []).forEach((e, n) => {
    const text = label[e.event];
    if (!text) return; // reminders
    seen.add(e.event);
    const note =
      e.event === 'status_corrected' && e.sample_date
        ? `Sample given on ${calendarDate(e.sample_date)}`
        : undefined;
    steps.push({
      key: `${e.event}-${n}`,
      label: text,
      at: labDayTime(e.at, zone),
      done: true,
      ...(note ? { note } : {}),
    });
  });
  if (!seen.has('sent'))
    steps.unshift({
      key: 'sent',
      label: `Sent by ${dr}`,
      at: labDayTime(r.sent_at, zone),
      done: true,
    });

  // Expiry is computed on read: the event may not be stored yet.
  const terminal = TERMINAL_EVENT[r.status];
  if (terminal === 'expired' && !seen.has('expired')) {
    steps.push({
      key: 'expired',
      label: 'Expired',
      at: labDayTime(r.expired_at ?? r.expires_at, zone),
      done: true,
    });
  }
  if (terminal) return steps;

  // Still open: the steps after the current status, in order (a support
  // correction can move the status without the patient's own event).
  const from = PENDING_FROM[r.status] ?? MAIN_PATH.length;
  for (const [event, text] of MAIN_PATH.slice(from)) {
    if (!seen.has(event))
      steps.push({ key: `pending-${event}`, label: text, at: '', done: false });
  }
  return steps;
}
