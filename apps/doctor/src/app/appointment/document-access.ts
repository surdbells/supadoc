import { NETWORK_ERROR_MESSAGE } from '@supadoc/data-access';
import type {
  DoctorDocumentAccessDto,
  DoctorSharedDocumentDto,
  DocumentAccessRequestKind,
} from '@supadoc/models';

/**
 * What a patient shares with the doctor, as the doctor portal shows it (the
 * appointment page's Documents tab and the call screen's Medical Records).
 * Pure helpers: copy, dates and refresh timing. The API decides what is
 * shared; nothing here widens or narrows it — it only describes the answer.
 *
 * Dates: only the server's `*_label_at` fields are formatted (an "until a
 * date" share ends at midnight, and its label is the minute before), so both
 * apps show the same last day.
 */

/** Background refresh of the appointment page's Documents tab (passive, while the doctor is active). */
export const PAGE_POLL_MS = 60_000;
/** Background refresh in the call (passive, while connected and the screen is visible). */
export const CALL_POLL_MS = 30_000;
/** Background refresh stops once nobody has touched the portal for this long. */
export const ACTIVE_WINDOW_MS = 5 * 60_000;
/** Bounds for the one-off refresh at `next_change_at`. */
export const MIN_REFRESH_MS = 1_000;
export const MAX_REFRESH_MS = 24 * 60 * 60_000;
/** The doctor's note on a request (the API cleans it and refuses longer). */
export const REQUEST_MESSAGE_MAX = 500;

export const FINE_PRINT =
  "Only documents the patient chooses to share appear here. Each time you open one, it's recorded and the patient can see it.";
export const LOAD_FAILED = "Could not load the patient's shared documents.";
export const NOT_SHARED = 'This document is no longer shared with you.';
export const VIEW_UNAVAILABLE = 'Could not open the document right now. Try again.';
export const OPEN_FAILED = 'Could not open the document. Please try again.';
export const CALL_SIGNED_OUT = 'Sign in to the doctor portal to see documents the patient shares.';
export const REQUEST_BODY =
  "They'll get a notification and choose what to share and for how long. You'll be told when they answer.";
export const REQUEST_HINT = "Shown to the patient in the app only. Don't include sensitive details.";
export const REQUEST_SENT = 'Request sent.';
export const REQUEST_WITHDRAWN = 'Request withdrawn.';
export const REQUEST_FAILED = 'Could not send the request. Please try again.';
export const WITHDRAW_FAILED = 'Could not withdraw the request. Please try again.';

/** "Withdraw your request?" (DialogService.confirm). */
export const WITHDRAW_PROMPT = {
  tone: 'warning' as const,
  icon: 'undo-2',
  title: 'Withdraw your request?',
  message: "The patient won't be asked any more.",
  confirmLabel: 'Withdraw',
  cancelLabel: 'Keep request',
};

export type AccessTone = 'success' | 'warning' | 'neutral' | 'info' | 'error';
export type AccessRowState = 'active_all' | 'ends_soon' | 'active_selected' | 'none' | 'unavailable';
export type RequestRowState = 'pending' | 'cooldown' | 'limit' | 'blocked' | 'not_eligible';
/** request / more / extend open the request dialog; withdraw asks first; retry reloads. */
export type AccessActionKind = 'request' | 'more' | 'extend' | 'withdraw' | 'retry';

export interface AccessAction {
  readonly kind: AccessActionKind;
  readonly label: string;
  readonly icon: string;
}

/** What the patient shares now (or that it could not be loaded). */
export interface AccessRow {
  readonly state: AccessRowState;
  readonly icon: string;
  readonly tone: AccessTone;
  readonly title: string | null;
  readonly body: string;
  readonly detail: string | null;
  readonly action: AccessAction | null;
}

/** Where the doctor's own request stands (waiting, declined lately, at the limit…). */
export interface RequestRow {
  readonly state: RequestRowState;
  readonly icon: string;
  readonly tone: AccessTone;
  readonly text: string;
  readonly action: AccessAction | null;
}

export interface AccessBanner {
  readonly access: AccessRow;
  readonly request: RequestRow | null;
  /** What a new request from here would be (an extension when a folder share ends soon). */
  readonly requestKind: DocumentAccessRequestKind;
}

// ----- Dates -----

const parse = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
};

function dateFmt(timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...(timeZone ? { timeZone } : {}) });
}

function timeFmt(timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
}

/** Hour and minute of an instant on the viewer's (or the given zone's) clock. */
function clock(d: Date, timeZone?: string): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(d);
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { h: num('hour'), m: num('minute') };
}

/** The calendar day of an instant on the viewer's (or the given zone's) clock, 'YYYY-MM-DD'. */
function dayKey(d: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/** "21 Oct 2026" ('' when missing). */
export function dateLabel(iso: string | null | undefined, timeZone?: string): string {
  const d = parse(iso);
  return d ? dateFmt(timeZone).format(d) : '';
}

/** "21 Oct 2026, 4:30 PM" ('' when missing). */
export function dateTimeLabel(iso: string | null | undefined, timeZone?: string): string {
  const d = parse(iso);
  return d ? `${dateFmt(timeZone).format(d)}, ${timeFmt(timeZone).format(d)}` : '';
}

/**
 * A share's end for people: "30 Oct 2026" for a share that runs to the end of
 * a day (its label is 23:59) or to midnight, else "30 Oct 2026, 4:30 PM";
 * "No end date" when indefinite; '' when there is no end to show.
 */
export function untilLabel(untilLabelAt: string | null | undefined, indefinite: boolean, timeZone?: string): string {
  if (indefinite) return 'No end date';
  const d = parse(untilLabelAt);
  if (!d) return '';
  const { h, m } = clock(d, timeZone);
  const dayOnly = (h === 23 && m === 59) || (h === 0 && m === 0);
  return dayOnly ? dateFmt(timeZone).format(d) : `${dateFmt(timeZone).format(d)}, ${timeFmt(timeZone).format(d)}`;
}

/** A shared document's line: "Shared until 30 Oct 2026" / "No end date". */
export function sharedUntilText(doc: Pick<DoctorSharedDocumentDto, 'shared_until_label_at' | 'shared_indefinitely'>, timeZone?: string): string {
  if (doc.shared_indefinitely) return 'No end date';
  const label = untilLabel(doc.shared_until_label_at, false, timeZone);
  return label ? `Shared until ${label}` : '';
}

// ----- The banner -----

/** The patient's name for copy ("the patient" until it has loaded). */
function who(patient: string | null | undefined): string {
  return patient?.trim() || 'the patient';
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const ACTION = {
  request: { kind: 'request', label: 'Request access', icon: 'key-round' },
  more: { kind: 'more', label: 'Ask for more', icon: 'key-round' },
  extend: { kind: 'extend', label: 'Ask to extend', icon: 'key-round' },
  withdraw: { kind: 'withdraw', label: 'Withdraw request', icon: 'undo-2' },
  retry: { kind: 'retry', label: 'Try again', icon: 'refresh-cw' },
} as const satisfies Record<AccessActionKind, AccessAction>;

/** The error state (a failed load, or document sharing switched off on the server). */
export function unavailableBanner(): AccessBanner {
  return {
    access: {
      state: 'unavailable',
      icon: 'triangle-alert',
      tone: 'error',
      title: null,
      body: LOAD_FAILED,
      detail: null,
      action: ACTION.retry,
    },
    request: null,
    requestKind: 'access',
  };
}

/**
 * The Documents banner for every state of §6.12: what the patient shares
 * (all / some / nothing, until when), and where the doctor's request stands.
 * `sharing_unavailable` (the API's kill switch) reads like a failed load.
 */
export function accessBanner(dto: DoctorDocumentAccessDto, patient: string | null | undefined, timeZone?: string): AccessBanner {
  const { access, request } = dto;
  if (request.blocked_reason === 'sharing_unavailable') return unavailableBanner();
  const p = who(patient);
  const requestKind: DocumentAccessRequestKind = request.kind ?? 'access';
  const canAsk = request.can_request && !request.pending;

  let row: AccessRow;
  if (access.state === 'active' && access.scope === 'all') {
    // The whole folder's end — not the latest end of everything visible: a
    // document shared on its own with no end date doesn't keep new uploads coming.
    const label = untilLabel(access.folder_until_label_at, false, timeZone);
    if (access.ends_soon) {
      row = {
        state: 'ends_soon',
        icon: 'hourglass',
        tone: 'warning',
        title: null,
        body: `${cap(p)} is sharing all their documents with you.`,
        detail: label ? `Access ends ${label}.` : 'Access ends soon.',
        action: canAsk && requestKind === 'extend' ? ACTION.extend : null,
      };
    } else {
      row = {
        state: 'active_all',
        icon: 'shield-check',
        tone: 'success',
        title: null,
        body: `${cap(p)} is sharing all their documents with you.`,
        detail: access.folder_indefinite ? 'No end date set by the patient.' : label ? `Access until ${label}` : null,
        action: null,
      };
    }
  } else if (access.state === 'active') {
    const n = access.document_count;
    const label = untilLabel(access.until_label_at, false, timeZone);
    row = {
      state: 'active_selected',
      icon: 'shield-check',
      tone: 'success',
      title: null,
      body: `${cap(p)} is sharing ${n} document${n === 1 ? '' : 's'} with you.`,
      detail: access.indefinite ? 'No end date set by the patient.' : label ? `Access until ${label}` : null,
      action: canAsk ? (requestKind === 'extend' ? ACTION.extend : ACTION.more) : null,
    };
  } else {
    row = {
      state: 'none',
      icon: 'lock',
      tone: 'neutral',
      title: 'No documents shared',
      body: access.had_access_before
        ? `${cap(p)} isn't sharing any documents with you at the moment.`
        : `${cap(p)} hasn't shared any documents with you. Patients choose what you can see and for how long.`,
      detail: null,
      action: canAsk ? ACTION.request : null,
    };
  }

  return { access: row, request: requestRow(dto, p, timeZone), requestKind };
}

function requestRow(dto: DoctorDocumentAccessDto, p: string, timeZone?: string): RequestRow | null {
  const { request } = dto;
  const pending = request.pending;
  if (pending && pending.status === 'pending') {
    return {
      state: 'pending',
      icon: 'hourglass',
      tone: 'warning',
      text: `Request sent ${dateLabel(pending.created_at, timeZone)}. Waiting for ${p} to answer — it closes on ${dateLabel(pending.expires_at, timeZone)}.`,
      action: ACTION.withdraw,
    };
  }
  const after = dateTimeLabel(request.available_at, timeZone);
  const askAgain = after ? `You can ask again after ${after}.` : 'You can ask again later.';
  switch (request.blocked_reason) {
    case 'request_pending':
      // The answer did not carry the request itself: say so without a date.
      return { state: 'pending', icon: 'hourglass', tone: 'warning', text: `Your request is waiting for ${p} to answer.`, action: null };
    case 'request_cooldown': {
      const last = request.last;
      const on = last?.status === 'declined' ? dateLabel(last.decided_at, timeZone) : '';
      return {
        state: 'cooldown',
        icon: 'clock',
        tone: 'warning',
        text: on ? `${cap(p)} declined your request on ${on}. ${askAgain}` : `${cap(p)} declined your last request. ${askAgain}`,
        action: null,
      };
    }
    case 'request_limit':
      return {
        state: 'limit',
        icon: 'clock',
        tone: 'warning',
        text: `You've reached the limit of access requests for now. ${askAgain}`,
        action: null,
      };
    case 'request_blocked':
      return { state: 'blocked', icon: 'info', tone: 'info', text: "You can't ask this patient right now.", action: null };
    case 'appointment_not_eligible':
      return {
        state: 'not_eligible',
        icon: 'info',
        tone: 'info',
        text: 'You can ask for access from an upcoming consultation or one in the last 30 days.',
        action: null,
      };
    default:
      // has_full_access (nothing to ask for), or a request can be made.
      return null;
  }
}

/** The dialog's title: "Ask Ada Obi to share documents" / "…to keep sharing". */
export function requestDialogTitle(kind: DocumentAccessRequestKind, patient: string | null | undefined): string {
  const p = who(patient);
  return kind === 'extend' ? `Ask ${p} to keep sharing` : `Ask ${p} to share documents`;
}

/**
 * Words for a refused request or withdrawal (`errors.code`), or null to use
 * the API's own message. Neutral when the patient blocked further requests.
 */
export function requestErrorCopy(code: string | null, availableAt: string | null, timeZone?: string): string | null {
  const after = dateTimeLabel(availableAt, timeZone);
  const askAgain = after ? ` You can ask again after ${after}.` : '';
  switch (code) {
    case 'request_pending':
      return 'You already have a request waiting for the patient to answer.';
    case 'request_cooldown':
      return `The patient declined your last request.${askAgain || ' You can ask again later.'}`;
    case 'request_limit':
      return `You've reached the limit of access requests for now.${askAgain || ' You can ask again later.'}`;
    case 'has_full_access':
      return 'The patient already shares all their documents with you.';
    case 'request_blocked':
      return "You can't ask this patient right now.";
    case 'appointment_not_eligible':
      return 'You can ask for access from an upcoming consultation or one in the last 30 days.';
    case 'doctor_unavailable':
      return "You can't ask patients for documents while your account isn't taking consultations.";
    case 'sharing_unavailable':
      return 'Document sharing is unavailable right now. Please try again later.';
    case 'request_not_pending':
      return 'This request was already answered or closed.';
    default:
      return null;
  }
}

/** A refusal that means the page is out of date: reload what the patient shares. */
export function isStaleRequestCode(code: string | null): boolean {
  return (
    code === 'request_pending' ||
    code === 'request_cooldown' ||
    code === 'request_limit' ||
    code === 'has_full_access' ||
    code === 'request_blocked' ||
    code === 'appointment_not_eligible' ||
    code === 'request_not_pending' ||
    code === 'sharing_unavailable'
  );
}

/** Why a shared document did not open (`openBlobDocument`'s onError). */
export function openErrorCopy(status: number, code: string | null): string {
  if (code === 'not_shared') return NOT_SHARED;
  if (code === 'view_unavailable') return VIEW_UNAVAILABLE;
  if (status === 0) return NETWORK_ERROR_MESSAGE;
  return OPEN_FAILED;
}

// ----- Refresh timing -----

/**
 * How long until the next share starts or ends (`next_change_at`), plus a
 * second so the server has moved past it; clamped to 1 s – 24 h. `now` is
 * the server's clock where known (`server_time`). Null when nothing changes.
 */
export function nextRefreshDelay(nextChangeAt: string | null | undefined, now: number): number | null {
  const at = parse(nextChangeAt);
  if (!at || !Number.isFinite(now)) return null;
  const ms = at.getTime() + 1_000 - now;
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, ms));
}

/**
 * A background refresh only while the page is on screen and somebody used the
 * portal in the last 5 minutes (a tab left open never polls an idle session).
 */
export function shouldBackgroundPoll(visible: boolean, lastActivityMs: number | null, now: number): boolean {
  return visible && lastActivityMs !== null && Number.isFinite(lastActivityMs) && now - lastActivityMs < ACTIVE_WINDOW_MS;
}

// ----- Call screen -----

/**
 * The line under "Medical Records" in the call: "Shared by the patient · until
 * 4:30 PM" (today: the time only), "· no end date", or "No documents shared".
 * With a whole-folder share the end is that share's own (a document shared on
 * its own with no end date doesn't make the folder open-ended).
 */
export function callHeaderLine(dto: DoctorDocumentAccessDto, now: number, timeZone?: string): string {
  const { access } = dto;
  if (access.state !== 'active') return 'No documents shared';
  const folder = access.scope === 'all';
  const indefinite = folder ? access.folder_indefinite : access.indefinite;
  const labelAt = folder ? access.folder_until_label_at : access.until_label_at;
  if (indefinite) return 'Shared by the patient · no end date';
  const d = parse(labelAt);
  if (!d) return 'Shared by the patient';
  const today = dayKey(d, timeZone) === dayKey(new Date(now), timeZone);
  const until = today ? timeFmt(timeZone).format(d) : untilLabel(labelAt, false, timeZone);
  return `Shared by the patient · until ${until}`;
}

export type CallRecordsTab = 'documents' | 'imaging' | 'labs';

/** The call's empty Records tab: nothing shared at all, or nothing of that kind. */
export function callEmptyCopy(tab: CallRecordsTab, state: 'none' | 'active'): { title: string; body: string | null } {
  if (tab === 'imaging') return { title: 'No shared imaging.', body: null };
  if (tab === 'labs') return { title: 'No shared lab reports.', body: null };
  return state === 'none'
    ? { title: 'No documents shared', body: "The patient hasn't shared any documents with you." }
    : { title: 'No documents yet', body: 'New uploads appear here while access lasts.' };
}
