import type { LabRequestsApi } from '@supadoc/data-access';
import type {
  AdminLabRequestSummaryDto,
  LabCorrectionTarget,
  LabPriority,
  LabRequestLinkDto,
  LabRequestStatus,
} from '@supadoc/models';
import { signedLinkSource, type ViewerSource } from '@supadoc/viewer';
import { map } from 'rxjs';

/*
 * The back office's lab-request helpers (lab spec §5): status and priority
 * labels, the correction choices, calendar dates and the request PDF's viewer
 * source. Import this file only from lazily loaded code (the patient page and
 * its dialog): it pulls in `@supadoc/viewer`, which must stay out of the
 * initial bundle.
 */

export interface LabChip {
  readonly label: string;
  readonly cls: string;
  readonly icon: string;
}

/**
 * The status chip: the doctor portal's labels and colours (`LAB_STATUS_META`,
 * lab spec §3.2), plus an icon, as every back-office status reads as icon +
 * words, never colour alone. Staff rows carry no review outcome, so there is
 * no "abnormal" variant here.
 */
export const LAB_STATUS_META: Readonly<Record<LabRequestStatus, LabChip>> = {
  awaiting_consent: { label: 'Awaiting Consent', cls: 'bg-warning/10 text-warning-ink', icon: 'hourglass' },
  booked: { label: 'Booked', cls: 'bg-cerulean/10 text-cerulean-dark', icon: 'calendar-check' },
  in_lab: { label: 'In Lab', cls: 'bg-teal/10 text-teal-ink', icon: 'flask-conical' },
  result_ready: { label: 'Result ready', cls: 'bg-sage/10 text-sage-ink', icon: 'file-check' },
  declined: { label: 'Declined', cls: 'bg-cloud text-slate', icon: 'circle-x' },
  cancelled: { label: 'Cancelled', cls: 'bg-cloud text-slate', icon: 'ban' },
  expired: { label: 'Expired', cls: 'bg-cloud text-slate', icon: 'clock' },
};

/** The chip of a status (an unknown one reads as itself). */
export function labStatusMeta(status: LabRequestStatus | string): LabChip {
  return LAB_STATUS_META[status as LabRequestStatus] ?? { label: String(status), cls: 'bg-cloud text-slate', icon: 'info' };
}

/** The status's words, for the dialog subtitle and the viewer header. */
export function labStatusLabel(status: LabRequestStatus | string): string {
  return labStatusMeta(status).label;
}

/** Priority words (lab spec §3.2 `LAB_PRIORITY_META`). */
export const LAB_PRIORITY_LABEL: Readonly<Record<LabPriority, string>> = {
  stat: 'STAT',
  urgent: 'Urgent',
  routine: 'Routine',
};

/** Priority text colour on the white row (AA): STAT in alert, Urgent in warning, Routine plain. */
export const LAB_PRIORITY_CLS: Readonly<Record<LabPriority, string>> = {
  stat: 'font-semibold text-alert-ink',
  urgent: 'font-semibold text-warning-ink',
  routine: 'text-ink',
};

export function labPriorityLabel(priority: LabPriority | string): string {
  return LAB_PRIORITY_LABEL[priority as LabPriority] ?? String(priority);
}

export function labPriorityCls(priority: LabPriority | string): string {
  return LAB_PRIORITY_CLS[priority as LabPriority] ?? 'text-ink';
}

/** The correction targets (C1–C4) as the status dialog's radio labels. */
export const LAB_CORRECTION_LABEL: Readonly<Record<LabCorrectionTarget, string>> = {
  in_lab: 'In Lab (sample given)',
  booked: 'Booked',
  awaiting_consent: 'Awaiting Consent (reopen)',
};

export function labCorrectionLabel(target: LabCorrectionTarget | string): string {
  return LAB_CORRECTION_LABEL[target as LabCorrectionTarget] ?? String(target);
}

/**
 * A correction that reopens the request (C3 declined → Awaiting Consent, C4
 * expired → Booked / Awaiting Consent): the patient is told it is open again.
 */
export function isReopen(from: LabRequestStatus | string, to: LabCorrectionTarget | string | null): boolean {
  return (from === 'declined' || from === 'expired') && (to === 'booked' || to === 'awaiting_consent');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A clinic calendar date ('Y-m-d') as "4 Nov 2026": read from its parts, never
 * through `new Date('Y-m-d')` or a zone conversion, so every viewer sees the
 * same day. '—' when it isn't one.
 */
export function calendarDate(ymd: string | null | undefined): string {
  const m = ymd ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim()) : null;
  if (!m) return '—';
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '—';
  return `${day} ${MONTHS[month - 1]} ${m[1]}`;
}

const SENT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** When the request was sent, in the staff member's browser zone ("4 Nov 2026, 16:30"). */
export function sentLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : SENT.format(d);
}

/**
 * A request PDF for staff (`labs.manage`): a signed staff link minted when the
 * viewer loads (one `lab_request.viewed` audit row per open), fetched as a
 * Blob. View and print only — staff get no Download (viewer spec §7.3).
 */
export function staffLabRequestSource(
  labApi: Pick<LabRequestsApi, 'staffLink' | 'fileBlob'>,
  row: Pick<AdminLabRequestSummaryDto, 'id' | 'number' | 'status' | 'doctor_name'>,
): ViewerSource {
  return signedLinkSource({
    key: 'lab:' + row.id,
    title: 'Lab request ' + row.number,
    typeLabel: 'Lab request',
    extension: 'pdf',
    meta: [labStatusLabel(row.status), ...(row.doctor_name ? [row.doctor_name] : [])],
    policy: 'staff_record',
    canDownload: false,
    link: () => labApi.staffLink(row.id, false).pipe(map((r) => r.data)),
    fetch: (url: string) => labApi.fileBlob({ url } as LabRequestLinkDto),
  });
}
