import { slotLabel } from '@supadoc/data-access';
import type { AppointmentDto, FollowUpOutcome, FollowUpPriceDto } from '@supadoc/models';
import type { ClinicalTone } from './clinical/clinical-ui';

/**
 * Follow-up helpers shared by the doctor's lists, the appointment record and
 * the call cockpit. A follow-up the doctor proposed is `proposed` until the
 * patient answers: it holds the slot but is not a booking (no call, not on
 * the day's schedule). The API labels it "Proposed"; to the doctor it is
 * "Awaiting patient".
 */

export const AWAITING_PATIENT = 'Awaiting patient';

/**
 * The earliest start a doctor can propose: 2h before the start the proposal
 * closes, and the patient gets at least 30 minutes to answer
 * (`FollowUpService::earliestProposalStart()`).
 */
export const PROPOSAL_MIN_LEAD_MINUTES = 150;
/** A proposal closes 2h before it starts... */
const CLOSE_HOURS_BEFORE_START = 2;
/** ...and at most 72h after it was made (`FollowUpService::expiresAt()`). */
const MAX_OPEN_HOURS = 72;
/** A doctor can propose from a confirmed consultation from this long before it starts. */
export const IN_CALL_LEAD_MINUTES = 120;

const HOUR = 3_600_000;
const DAY_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** "Tue 21 Oct, 3:00 PM" in the viewer's local time (the slot pills' clock). */
export function whenLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : `${DAY_FMT.format(d)}, ${slotLabel(iso)}`;
}

/** "14 Oct 2026" (local). */
export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : DATE_FMT.format(d);
}

/** "Tue 21 Oct" for a local `YYYY-MM-DD` (formatted as that calendar day). */
export function dayLabel(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? DAY_FMT.format(new Date(+m[1], +m[2] - 1, +m[3])) : ymd;
}

/** A proposal the patient can still answer: `proposed` and not past its expiry. */
export function isOpenProposal(a: Pick<AppointmentDto, 'status' | 'expires_at'>, now: number): boolean {
  if (a.status !== 'proposed') return false;
  const closes = a.expires_at ? new Date(a.expires_at).getTime() : NaN;
  return !isNaN(closes) && closes > now;
}

/** A doctor's proposal that closed without being accepted (declined, withdrawn or expired): it was never a booking. */
export function isClosedProposal(a: AppointmentDto): boolean {
  // The API records how it closed; older rows are told apart by never having been paid.
  return a.status === 'cancelled' && (!!a.follow_up_outcome || neverAccepted(a));
}

/**
 * The withdraw endpoint's answer when the proposal had already closed — the
 * patient declined it or it expired a moment before (`WithdrawFollowUpAction`).
 * It is a 200 like a real withdrawal, so only the message tells them apart.
 */
export const PROPOSAL_ALREADY_CLOSED = 'Follow-up proposal already closed';

/** This withdraw call closed the proposal (rather than finding it already closed). */
export function withdrewProposal(res: { message: string }): boolean {
  return res.message !== PROPOSAL_ALREADY_CLOSED;
}

/** When a proposal for `startMs` made at `now` would close: 2h before it starts, at most 72h from now. */
export function proposalExpiry(startMs: number, now: number): number {
  return Math.min(startMs - CLOSE_HOURS_BEFORE_START * HOUR, now + MAX_OPEN_HOURS * HOUR);
}

/**
 * The status text a doctor list shows: the API's label, except a proposal
 * ("Awaiting patient") and a doctor's proposal that closed without being
 * accepted (how it closed, as far as the payload tells — see {@link followUpState}).
 */
export function doctorStatusLabel(a: AppointmentDto, now = Date.now()): string {
  if (a.status === 'proposed') return isOpenProposal(a, now) ? AWAITING_PATIENT : 'Expired';
  if (isClosedProposal(a)) return followUpState(a, now).label;
  return a.status_label;
}

/** How a follow-up stands, for the doctor's follow-up lists (icon + text, never colour alone). */
export interface FollowUpState {
  readonly label: string;
  readonly icon: string;
  readonly tone: ClinicalTone;
  /** Still waiting for the patient (it can be withdrawn). */
  readonly open: boolean;
}

/** A doctor's proposal that was never accepted: accepting it takes the payment (a free one is marked paid). */
function neverAccepted(a: AppointmentDto): boolean {
  return a.proposed_by === 'doctor' && (a.payment_status ?? 'unpaid') === 'unpaid';
}

/** How a closed proposal closed, as the API recorded it (`follow_up_outcome`). */
const CLOSED_AS: Readonly<Record<FollowUpOutcome, FollowUpState>> = {
  declined: { label: 'Declined', icon: 'circle-x', tone: 'danger', open: false },
  withdrawn: { label: 'Withdrawn', icon: 'undo-2', tone: 'neutral', open: false },
  expired: { label: 'Expired', icon: 'clock', tone: 'neutral', open: false },
};

/**
 * How a follow-up stands. A proposal that closed without being accepted is
 * `cancelled` whichever way it closed; the API records how
 * (`follow_up_outcome`: declined, withdrawn — by the doctor or the back
 * office — or expired). Proposals closed before it did fall back on what the
 * payload shows: the patient gave a reason (Declined — it wins, since a
 * patient's reply can beat the doctor's Withdraw), or this session withdrew
 * it here (`withdrawn`); otherwise "Not accepted" — declined without a
 * reason, withdrawn earlier, or expired.
 */
export function followUpState(f: AppointmentDto, now: number, withdrawn?: ReadonlySet<string>): FollowUpState {
  switch (f.status) {
    case 'proposed':
      return isOpenProposal(f, now)
        ? { label: 'Proposed — awaiting patient', icon: 'hourglass', tone: 'warning', open: true }
        : { label: 'Expired', icon: 'clock', tone: 'neutral', open: false };
    case 'pending':
      return { label: f.status_label, icon: 'hourglass', tone: 'warning', open: false };
    case 'rescheduled':
      return { label: f.status_label, icon: 'refresh-cw', tone: 'neutral', open: false };
    case 'confirmed':
      return { label: 'Confirmed', icon: 'circle-check', tone: 'success', open: false };
    case 'completed':
      return { label: 'Completed', icon: 'calendar-check', tone: 'brand', open: false };
    case 'cancelled':
      if (f.follow_up_outcome && CLOSED_AS[f.follow_up_outcome]) return CLOSED_AS[f.follow_up_outcome];
      if (!neverAccepted(f)) return { label: 'Cancelled', icon: 'ban', tone: 'danger', open: false };
      if (f.decline_reason) return { label: 'Declined', icon: 'circle-x', tone: 'danger', open: false };
      if (withdrawn?.has(f.id)) return { label: 'Withdrawn', icon: 'undo-2', tone: 'neutral', open: false };
      return { label: 'Not accepted', icon: 'circle-x', tone: 'neutral', open: false };
  }
}

/** "₦5,000.00" (or "Free" for 0). Money is a string from the API. */
export function moneyLabel(amount: string | number | null | undefined, currency = 'NGN'): string {
  const n = Number(amount ?? 0);
  if (!isFinite(n) || n <= 0) return 'Free';
  const sym = currency === 'NGN' ? '₦' : `${currency} `;
  return sym + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Why a follow-up costs what it does, e.g. "50% follow-up discount". */
export function priceRuleText(p: Pick<FollowUpPriceDto, 'rule' | 'discount_percent' | 'window_days'>): string {
  switch (p.rule) {
    case 'waived':
      return 'Fee waived';
    case 'free':
      return `Free follow-up within ${p.window_days} days`;
    case 'percent':
      return `${p.discount_percent}% follow-up discount`;
    case 'full':
      return 'Your full consultation fee';
    case 'outside_window':
      return `Full fee — more than ${p.window_days} days after the consultation`;
  }
}

/** A follow-up's price for a list: "Free · Fee waived", "₦5,000.00 · 50% follow-up discount". */
export function followUpPriceLabel(f: AppointmentDto): string {
  const price = moneyLabel(f.amount);
  return f.follow_up_pricing ? `${price} · ${priceRuleText(f.follow_up_pricing)}` : price;
}
