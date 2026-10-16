import type {
  ApiAppointmentStatus,
  AppointmentClosureReason,
  AppointmentDisplayStatus,
  AppointmentDto,
  AppointmentNoShow,
  AppointmentPhase,
  AppointmentRescheduledBy,
} from '@supadoc/models';

/**
 * How the back office shows an appointment's state — one place for every
 * screen (list, detail, dashboard, analytics, monitoring, patient and doctor
 * pages). Lists and badges follow the server's lifecycle fields
 * (`phase`, `display_status`, `display_label`, `display_detail`) rather than
 * re-deriving them from the status; the raw-status maps are for rows that only
 * carry `status` (monitoring, analytics, the overview).
 */

/** A badge: words + icon, never colour alone. */
export interface AppointmentBadge {
  readonly label: string;
  readonly icon: string;
  readonly cls: string;
  /** A line under the badge, e.g. "Doctor didn't attend" (staff wording). */
  readonly detail: string | null;
  /** In progress now (a pulsing dot instead of the icon). */
  readonly live: boolean;
}

export const APPOINTMENT_STATUS_LABEL: Record<ApiAppointmentStatus, string> = {
  proposed: 'Proposed',
  pending: 'Pending',
  confirmed: 'Confirmed',
  rescheduled: 'Rescheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
  missed: 'Missed',
};

const STATUS_CLASS: Record<ApiAppointmentStatus, string> = {
  proposed: 'bg-teal/10 text-teal-ink',
  pending: 'bg-warning/15 text-ink',
  confirmed: 'bg-sage/15 text-sage-ink',
  rescheduled: 'bg-cloud text-slate',
  completed: 'bg-frost text-cerulean-dark',
  cancelled: 'bg-alert/10 text-alert-ink',
  missed: 'bg-ocean/10 text-ocean',
};

const STATUS_ICON: Record<ApiAppointmentStatus, string> = {
  proposed: 'refresh-cw',
  pending: 'hourglass',
  confirmed: 'calendar-check',
  rescheduled: 'calendar-clock',
  completed: 'circle-check',
  cancelled: 'circle-x',
  missed: 'calendar-x',
};

/** Chart colours per status (`text-*`; the legend dot uses the matching `bg-*`: bg-teal bg-warning bg-sage bg-slate bg-cerulean bg-alert bg-ocean). */
export const APPOINTMENT_STATUS_COLOR: Record<ApiAppointmentStatus, string> = {
  proposed: 'text-teal',
  pending: 'text-warning',
  confirmed: 'text-sage',
  rescheduled: 'text-slate',
  completed: 'text-cerulean',
  cancelled: 'text-alert',
  missed: 'text-ocean',
};

const DISPLAY: Record<Exclude<AppointmentDisplayStatus, 'upcoming'>, { cls: string; icon: string }> = {
  live: { cls: 'bg-sage/15 text-sage-ink', icon: 'video' },
  finalising: { cls: 'bg-warning/15 text-ink', icon: 'hourglass' },
  completed: { cls: 'bg-frost text-cerulean-dark', icon: 'circle-check' },
  cancelled: { cls: 'bg-alert/10 text-alert-ink', icon: 'circle-x' },
  missed: { cls: 'bg-ocean/10 text-ocean', icon: 'calendar-x' },
  not_confirmed: { cls: 'bg-cloud text-slate', icon: 'calendar-off' },
  expired: { cls: 'bg-cloud text-slate', icon: 'clock' },
};

/** Badge colours for a raw status ('bg-cloud text-slate' for anything unknown). */
export function appointmentStatusClass(status: string | null | undefined): string {
  return STATUS_CLASS[status as ApiAppointmentStatus] ?? 'bg-cloud text-slate';
}

/** A raw status in words (the status itself, prettified, when unknown). */
export function appointmentStatusLabel(status: string | null | undefined): string {
  return APPOINTMENT_STATUS_LABEL[status as ApiAppointmentStatus] ?? (status ?? '—').replace(/_/g, ' ');
}

type BadgeSource = Pick<AppointmentDto, 'status' | 'status_label'> &
  Partial<Pick<AppointmentDto, 'display_status' | 'display_label' | 'display_detail'>>;

/**
 * The badge for an appointment, from the server's display fields (an older
 * payload without them falls back to the status).
 */
export function appointmentBadge(a: BadgeSource): AppointmentBadge {
  const ds = a.display_status;
  const label = a.display_label || a.status_label || appointmentStatusLabel(a.status);
  const detail = a.display_detail ?? null;
  if (!ds || ds === 'upcoming') {
    return { label, icon: STATUS_ICON[a.status] ?? 'calendar-days', cls: appointmentStatusClass(a.status), detail, live: false };
  }
  const d = DISPLAY[ds] ?? { cls: appointmentStatusClass(a.status), icon: STATUS_ICON[a.status] ?? 'calendar-days' };
  return { label, icon: d.icon, cls: d.cls, detail, live: ds === 'live' };
}

/** The "needs attention" flag (past and still open). */
export const ATTENTION_BADGE = {
  label: 'Needs attention',
  icon: 'triangle-alert',
  cls: 'bg-warning/15 text-ink',
} as const;

/** Who didn't come to a missed consultation, for staff. */
export const NO_SHOW_LABEL: Record<AppointmentNoShow, string> = {
  doctor: "Doctor didn't attend",
  patient: "Patient didn't join",
  both: 'Neither joined',
};

/** Why it was closed (when not by an ordinary patient / doctor action). */
export const CLOSURE_LABEL: Record<AppointmentClosureReason, string> = {
  expired_unconfirmed: "Closed automatically — the doctor didn't confirm in time",
  no_show: 'Marked missed',
  auto_completed: 'Closed automatically — the consultation took place',
  staff_cancelled: 'Cancelled by the back office',
  staff_completed: 'Marked held by the back office',
};

/**
 * How it closed, plus what went back to the wallet when something did — an
 * unpaid, free or staff booking closes with no refund, so none is claimed.
 */
export function appointmentClosureLabel(a: Pick<AppointmentDto, 'closure_reason'> & Partial<Pick<AppointmentDto, 'refunded_amount'>>): string {
  if (!a.closure_reason) return '—';
  const base = CLOSURE_LABEL[a.closure_reason] ?? a.closure_reason.replace(/_/g, ' ');
  return hasRefund(a) ? `${base} (${naira(a.refunded_amount)} refunded)` : base;
}

export const RESCHEDULED_BY_LABEL: Record<AppointmentRescheduledBy, string> = {
  patient: 'The patient',
  doctor: 'The doctor',
  staff: 'The back office',
};

/**
 * The time phase, from the server; an older payload without it is worked out
 * from the start time and a 60-minute slot.
 */
export function appointmentPhase(a: Pick<AppointmentDto, 'status' | 'scheduled_at'> & Partial<Pick<AppointmentDto, 'phase' | 'ends_at'>>, now = Date.now()): AppointmentPhase {
  if (a.phase) return a.phase;
  if (a.status === 'completed' || a.status === 'cancelled' || a.status === 'missed') return 'past';
  const start = new Date(a.scheduled_at).getTime();
  const end = a.ends_at ? new Date(a.ends_at).getTime() : start + 60 * 60_000;
  if (isNaN(start) || now < start) return 'upcoming';
  return now < end + 30 * 60_000 ? 'live' : 'past';
}

/**
 * What was paid for it and can still go back to the patient's wallet (the
 * API's Appointment::refundableAmount): nothing for an unpaid or free booking.
 */
export function refundableAmount(a: Pick<AppointmentDto, 'amount' | 'payment_status'> & Partial<Pick<AppointmentDto, 'refunded_amount'>>): number {
  const amount = Number(a.amount) || 0;
  if (amount <= 0 || (a.payment_status !== 'paid' && a.payment_status !== 'refunded')) return 0;
  // An older payload without refunded_amount: `refunded` means all of it went back.
  const refunded =
    a.refunded_amount !== null && a.refunded_amount !== undefined
      ? Number(a.refunded_amount) || 0
      : a.payment_status === 'refunded'
        ? amount
        : 0;
  const left = Math.round((amount - refunded) * 100) / 100;
  return left > 0 ? left : 0;
}

/** Whether anything went back to the wallet for it. */
export function hasRefund(a: Partial<Pick<AppointmentDto, 'refunded_amount'>>): boolean {
  return (Number(a.refunded_amount) || 0) > 0;
}

/** "₦12,500.00" (another currency: "USD 12,500.00"); a dash for nothing. */
export function naira(amount: string | number | null | undefined, currency = 'NGN'): string {
  const n = Number(amount);
  if (amount === null || amount === undefined || amount === '' || isNaN(n)) return '—';
  const sym = currency === 'NGN' ? '₦' : `${currency} `;
  return sym + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const WHEN_DAY_TIME = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const TIME = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' });

/** "Tue 14 Oct 2026, 10:30–11:00" in the viewer's zone (the end when known). */
export function appointmentWhen(a: Pick<AppointmentDto, 'scheduled_at'> & Partial<Pick<AppointmentDto, 'ends_at'>>): string {
  const start = new Date(a.scheduled_at);
  if (isNaN(start.getTime())) return '—';
  const end = a.ends_at ? new Date(a.ends_at) : null;
  const sameDay = end && !isNaN(end.getTime()) && end.toDateString() === start.toDateString();
  return WHEN_DAY_TIME.format(start) + (sameDay && end ? `–${TIME.format(end)}` : '');
}

/** "3 hours ago", "in 2 days" — coarse, for "ended … ago" lines. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const diff = t - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60_000, 'second'],
    [3_600_000, 'minute'],
    [86_400_000, 'hour'],
    [Infinity, 'day'],
  ];
  const sizes: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };
  for (const [limit, unit] of steps) {
    if (abs < limit) return rtf.format(Math.round(diff / sizes[unit]), unit);
  }
  return '';
}
