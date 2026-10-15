import type { AppointmentDto } from '@supadoc/models';
import { moneyLabel } from './follow-ups';

/**
 * How the doctor's lists show an appointment, from the server's lifecycle
 * fields (`phase`, `display_status`, `display_label`, `display_detail`) — never
 * re-derived from the status alone, so a past booking that was never closed
 * reads "Not confirmed" / "Being finalised" / "Missed" instead of "Pending" or
 * "Confirmed". Older payloads without those fields fall back on the status and
 * the clock.
 */

type StatusFields = Pick<AppointmentDto, 'status' | 'display_status'>;

/**
 * The key the badges are styled by: the display status — or, while it is still
 * to come, the booking status itself (pending / confirmed / rescheduled /
 * proposed).
 */
export function statusKey(a: StatusFields): string {
  const d = a.display_status;
  return !d || d === 'upcoming' ? a.status : d;
}

/** A badge's icon, pill colours and plain-text colour (always icon + text, never colour alone). */
export interface StatusLook {
  readonly icon: string;
  /** Pill background + text. */
  readonly pill: string;
  /** Text colour where there is no pill (compact agenda rows). */
  readonly text: string;
}

const LOOK: Readonly<Record<string, StatusLook>> = {
  // A follow-up waiting for the patient: ink on the amber tint (amber text is below AA on it).
  proposed: { icon: 'calendar-clock', pill: 'bg-warning/15 text-ink', text: 'text-ink' },
  pending: { icon: 'hourglass', pill: 'bg-warning/15 text-ink', text: 'text-warning' },
  rescheduled: { icon: 'refresh-cw', pill: 'bg-warning/15 text-ink', text: 'text-warning' },
  confirmed: { icon: 'circle-check', pill: 'bg-sage/15 text-sage', text: 'text-sage' },
  live: { icon: 'video', pill: 'bg-cerulean text-white', text: 'text-cerulean' },
  finalising: { icon: 'hourglass', pill: 'bg-cloud text-ink', text: 'text-slate' },
  completed: { icon: 'calendar-check', pill: 'bg-frost text-cerulean', text: 'text-cerulean' },
  cancelled: { icon: 'circle-x', pill: 'bg-alert/10 text-alert', text: 'text-alert' },
  missed: { icon: 'calendar-x', pill: 'bg-alert/10 text-alert', text: 'text-alert' },
  not_confirmed: { icon: 'calendar-off', pill: 'bg-cloud text-slate', text: 'text-slate' },
  expired: { icon: 'clock', pill: 'bg-cloud text-slate', text: 'text-slate' },
};

const FALLBACK: StatusLook = { icon: 'info', pill: 'bg-cloud text-slate', text: 'text-slate' };

/** Icon + colours for a status key (see {@link statusKey}). */
export function lookFor(key: string): StatusLook {
  return LOOK[key] ?? FALLBACK;
}

/** Icon + colours for an appointment. */
export function statusLook(a: StatusFields): StatusLook {
  return lookFor(statusKey(a));
}

/**
 * The line under the badge, worded for the doctor ("Patient didn't join",
 * "You didn't confirm in time", "Awaiting your confirmation"…), or null —
 * also when it would only repeat the badge (`label`).
 */
export function statusDetail(a: Pick<AppointmentDto, 'display_detail'>, label = ''): string | null {
  const d = (a.display_detail ?? '').trim();
  return d && d.toLowerCase() !== label.trim().toLowerCase() ? d : null;
}

const CLOSED = new Set(['completed', 'cancelled', 'missed']);

/** A consultation stays live this long after its end (the API's grace). */
export const LIVE_GRACE_MS = 30 * 60_000;

/**
 * When an appointment's time is over: its end (start + slot; older payloads:
 * the start) plus the 30-minute grace — NaN for a bad date.
 */
export function pastAfter(a: Pick<AppointmentDto, 'scheduled_at' | 'ends_at'>): number {
  return new Date(a.ends_at ?? a.scheduled_at).getTime() + LIVE_GRACE_MS;
}

/**
 * Over — closed, ended (more than 30 minutes past its end with nobody in the
 * call) or a lapsed proposal: it belongs in History, not the schedule.
 *
 * The server's `phase` decides — except that an `upcoming` snapshot goes stale
 * on a page left open, so it is re-checked against the clock (a live one stays
 * live: someone may still be in the call; past never comes back).
 */
export function isPast(a: Pick<AppointmentDto, 'status' | 'phase' | 'scheduled_at' | 'ends_at'>, now = Date.now()): boolean {
  if (a.phase === 'past') return true;
  if (a.phase === 'live') return false;
  if (CLOSED.has(a.status)) return true;
  const end = pastAfter(a);
  return !isNaN(end) && end < now;
}

/** Started and not yet over (or someone is in the call). */
export function isLive(a: Pick<AppointmentDto, 'phase'>): boolean {
  return a.phase === 'live';
}

/** A booking still open — pending, confirmed or rescheduled (whatever the time). */
export function isOpenBooking(a: Pick<AppointmentDto, 'status'>): boolean {
  return a.status === 'pending' || a.status === 'confirmed' || a.status === 'rescheduled';
}

/**
 * The doctor may still confirm this request: pending / rescheduled and not yet
 * 30 minutes past its end (`can_confirm`; older payloads: still open).
 */
export function canConfirm(a: Pick<AppointmentDto, 'status' | 'can_confirm'>): boolean {
  if (a.status !== 'pending' && a.status !== 'rescheduled') return false;
  return a.can_confirm ?? true;
}

/** What happened to a past consultation, for its record page (null while it is still to come or live). */
export interface StatusOutcome {
  readonly icon: string;
  readonly tone: 'neutral' | 'warning' | 'danger' | 'success';
  readonly title: string;
  readonly text: string;
}

/**
 * The record page's outcome note for a consultation that is over but wasn't
 * simply completed or cancelled: missed (who didn't come, and what that means
 * for the fee), a request not confirmed in time, or one that ended and is
 * being closed.
 */
export function statusOutcome(a: AppointmentDto): StatusOutcome | null {
  // What went back to the patient ("" when nothing did — unpaid, free, or no refund).
  const refunded = Number(a.refunded_amount ?? 0) > 0 ? moneyLabel(a.refunded_amount) : '';
  switch (a.display_status) {
    case 'missed':
      switch (a.no_show) {
        case 'patient':
          return {
            icon: 'user-x',
            tone: 'warning',
            title: "Missed — the patient didn't join",
            text: `You were there and the patient wasn't, so the fee counts towards your earnings${refunded ? ` (${refunded} of it was refunded to them under the no-show policy)` : ''}.`,
          };
        case 'doctor':
          return {
            icon: 'calendar-x',
            tone: 'danger',
            title: "Missed — you didn't attend",
            text: `${refunded ? `The patient was refunded in full (${refunded}) and no` : 'No'} fee is earned. If this consultation did take place, contact the VideoMed team to have it marked held.`,
          };
        case 'both':
          return {
            icon: 'calendar-x',
            tone: 'neutral',
            title: 'Missed — neither of you joined',
            text: `No fee is earned${refunded ? `, and ${refunded} was refunded to the patient` : ''}.`,
          };
        default:
          return {
            icon: 'calendar-x',
            tone: 'neutral',
            title: 'Missed',
            text: 'This consultation was closed as missed.',
          };
      }
    case 'not_confirmed':
      return {
        icon: 'calendar-off',
        tone: 'neutral',
        title: 'Not confirmed in time',
        // Only claim a refund that happened: unpaid bookings and free follow-ups had nothing to give back.
        text:
          a.status === 'cancelled'
            ? `This request ended before you confirmed it, so it was cancelled${refunded ? ` and the patient refunded ${refunded}` : ' — nothing was charged'}.`
            : "This request ended before you confirmed it. It's cancelled automatically — if anything was paid, it's refunded to the patient in full.",
      };
    case 'finalising':
      // An unconfirmed request only shows "finalising" when both sides joined, and the
      // reminders cron never expires those: it completes it on proof, otherwise it is
      // left for the back office — so no automatic refund is promised here.
      if (a.status !== 'confirmed') {
        return {
          icon: 'hourglass',
          tone: 'warning',
          title: 'Ended — being finalised',
          text:
            'This request ended before you confirmed it, but you both joined. It closes as completed once your note or a prescription shows it took place; otherwise our team reviews it with the patient.',
        };
      }
      return {
        icon: 'hourglass',
        tone: 'warning',
        title: 'Ended — being finalised',
        text:
          'This consultation has ended. It closes automatically: completed once your note, a prescription or the call shows it took place, otherwise marked missed. If it took place, you can mark it completed now.',
      };
    default:
      return null;
  }
}
