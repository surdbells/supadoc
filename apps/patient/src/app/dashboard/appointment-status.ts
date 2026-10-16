import type {
  ApiAppointmentStatus,
  AppointmentDisplayStatus,
  AppointmentDto,
  AppointmentPhase,
} from '@supadoc/models';
import { isUntakenProposal } from './follow-up';

/**
 * How the patient app shows an appointment's state — one place for every list,
 * card and details page. The server decides (`phase`, `display_status`,
 * `display_label`, `display_detail`); this only picks colours and icons, and
 * falls back to the status for an older payload that lacks those fields.
 *
 * Lists split by TIME (`phase` / `?when=`), never by status: Appointments shows
 * what is still to come or live, History everything that is over — completed,
 * cancelled, missed, or ended and not closed yet — whatever its status.
 */
export interface StatusBadge {
  /** The server's display status (or one derived from an old payload). */
  readonly key: AppointmentDisplayStatus;
  /** "Confirmed", "In progress", "Missed", "Not confirmed"… */
  readonly label: string;
  /** Background + text classes for the pill (always paired with the label — never colour alone). */
  readonly class: string;
  /** Lucide icon shown with the label. */
  readonly icon: string;
  /** The line under the badge for the patient, e.g. "Doctor didn't attend" ('' when none). */
  readonly detail: string;
}

/** Closed statuses — nothing more will happen to these bookings. */
export const CLOSED_STATUSES: readonly ApiAppointmentStatus[] = ['completed', 'cancelled', 'missed'];
/** Bookings still open (the doctor may confirm, the call can happen, the cron may close it). */
export const OPEN_STATUSES: readonly ApiAppointmentStatus[] = ['pending', 'confirmed', 'rescheduled'];

/** Upcoming bookings take their colour from the underlying status. */
const UPCOMING_CLASS: Partial<Record<ApiAppointmentStatus, string>> = {
  proposed: 'bg-teal/10 text-teal-ink',
  pending: 'bg-warning/15 text-warning-ink',
  confirmed: 'bg-sage/15 text-sage-ink',
  rescheduled: 'bg-cloud text-slate',
};

const UPCOMING_ICON: Partial<Record<ApiAppointmentStatus, string>> = {
  proposed: 'calendar-plus',
  pending: 'hourglass',
  confirmed: 'circle-check',
  rescheduled: 'calendar-clock',
};

const DISPLAY_STYLE: Record<Exclude<AppointmentDisplayStatus, 'upcoming'>, { class: string; icon: string }> = {
  live: { class: 'bg-success/15 text-success-ink', icon: 'video' },
  finalising: { class: 'bg-frost text-cerulean-dark', icon: 'hourglass' },
  completed: { class: 'bg-sage/15 text-sage-ink', icon: 'circle-check' },
  cancelled: { class: 'bg-alert/10 text-alert-ink', icon: 'circle-x' },
  missed: { class: 'bg-warning/15 text-warning-ink', icon: 'calendar-x' },
  not_confirmed: { class: 'bg-cloud text-slate', icon: 'calendar-off' },
  expired: { class: 'bg-cloud text-slate', icon: 'hourglass' },
};

const FALLBACK_STYLE = { class: 'bg-cloud text-slate', icon: 'info' } as const;

/** The display status an older payload (without `display_status`) implies. */
function derivedDisplay(a: AppointmentDto): AppointmentDisplayStatus {
  switch (a.status) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'missed':
      return 'missed';
    default:
      return 'upcoming';
  }
}

/** Where the appointment is in time (the server's `phase`; derived for an older payload). */
export function phaseOf(a: AppointmentDto): AppointmentPhase {
  if (a.phase) return a.phase;
  return CLOSED_STATUSES.includes(a.status) ? 'past' : 'upcoming';
}

/** Over: History's, not Appointments'. */
export function isPast(a: AppointmentDto): boolean {
  return phaseOf(a) === 'past';
}

/** The badge (label, colours, icon) and the detail line for this appointment. */
export function statusBadge(a: AppointmentDto): StatusBadge {
  const key = a.display_status ?? derivedDisplay(a);
  const label = a.display_label || a.status_label;
  const detail = a.display_detail ?? '';
  if (key === 'upcoming') {
    return {
      key,
      label,
      class: UPCOMING_CLASS[a.status] ?? 'bg-cloud text-slate',
      icon: UPCOMING_ICON[a.status] ?? 'calendar-days',
      detail,
    };
  }
  // A display status the server adds later still renders (neutral pill) rather than breaking the page.
  const style = DISPLAY_STYLE[key as keyof typeof DISPLAY_STYLE] ?? FALLBACK_STYLE;
  return { key, label, class: style.class, icon: style.icon, detail };
}

/**
 * Where its details live: History for anything over (except a follow-up
 * proposal, which is answered — or shown as no longer answerable — on the
 * appointment page), Appointments for what is still to come or live.
 */
export function detailsLink(a: AppointmentDto): string[] {
  const proposal = a.status === 'proposed' || isUntakenProposal(a);
  return isPast(a) && !proposal ? ['/dashboard/history', a.id] : ['/dashboard/appointments', a.id];
}

const NAIRA = new Intl.NumberFormat('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "₦12,500.00" ('' for nothing / zero). */
export function nairaLabel(amount: string | number | null | undefined): string {
  const n = Number(amount);
  return n > 0 ? `₦${NAIRA.format(n)}` : '';
}

/**
 * One sentence on how a closed booking ended, for the patient — what happened
 * and what went back to their wallet ('' when there is nothing to add). Never
 * names the reason for the visit.
 */
export function outcomeNote(a: AppointmentDto): string {
  const refunded = nairaLabel(a.refunded_amount) || (a.payment_status === 'refunded' ? nairaLabel(a.amount) : '');
  const back = refunded ? ` ${refunded} went back to your wallet.` : '';
  if (a.status === 'missed') {
    switch (a.no_show) {
      case 'doctor':
        // Only claim a refund the payload shows: none is posted for a free visit or a staff "no refund" resolution.
        return `Your doctor didn't attend this consultation, so it was closed as missed.${back}`;
      case 'patient':
        return `You didn't join this consultation, so it was closed as missed.${back}`;
      case 'both':
        return `Neither you nor your doctor joined this consultation, so it was closed as missed.${back}`;
      default:
        return `This consultation was closed as missed.${back}`;
    }
  }
  if (a.status === 'cancelled' && a.closure_reason === 'expired_unconfirmed') {
    return `Your doctor didn't confirm this consultation in time, so it was cancelled.${back}`;
  }
  if (a.status === 'cancelled' && a.closure_reason === 'staff_cancelled') {
    return `Our team cancelled this consultation.${back}`;
  }
  if (a.status === 'cancelled') return back.trim();
  return '';
}
