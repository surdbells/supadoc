import type { AppointmentDto, FollowUpPriceDto } from '@supadoc/models';

/**
 * Follow-up helpers shared by the patient's appointment, history, prescription
 * and booking pages. Every time is shown in the patient's local time.
 */

const NAIRA = new Intl.NumberFormat('en-NG', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const WHEN = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** A doctor's proposal the patient can still answer (not accepted, declined, withdrawn or expired). */
export function isOpenProposal(a: AppointmentDto | null | undefined, now = Date.now()): boolean {
  if (!a || a.status !== 'proposed' || !a.expires_at) return false;
  const closes = new Date(a.expires_at).getTime();
  return !isNaN(closes) && closes > now;
}

/** A proposal whose time to answer has run out (the server closes it shortly after). */
export function isExpiredProposal(a: AppointmentDto | null | undefined, now = Date.now()): boolean {
  return !!a && a.status === 'proposed' && !isOpenProposal(a, now);
}

/**
 * A doctor's proposal that closed without the patient taking it up (declined,
 * withdrawn or expired). Accepting always marks it paid — even a free one —
 * and a later cancellation leaves it paid or refunded, so `unpaid` tells them apart.
 */
export function isUntakenProposal(a: AppointmentDto | null | undefined): boolean {
  return !!a && a.proposed_by === 'doctor' && a.status === 'cancelled' && a.payment_status === 'unpaid';
}

/** "Tue 21 Oct, 3:00 PM" in the viewer's local time. */
export function whenLabel(iso: string | null | undefined): string {
  const d = new Date(iso ?? '');
  return isNaN(d.getTime()) ? '' : `${WHEN.format(d)}, ${TIME.format(d)}`;
}

/** "12 Oct 2026" — the day a consultation took place, in local time. */
export function dayLabel(iso: string | null | undefined): string {
  const d = new Date(iso ?? '');
  return isNaN(d.getTime()) ? '' : DAY.format(d);
}

/** Money as "₦12,500.00", or "Free" when there is nothing to pay (never "₦0.00"). */
export function priceLabel(amount: string | number | null | undefined): string {
  const n = Number(amount);
  return n > 0 ? `₦${NAIRA.format(n)}` : 'Free';
}

/** Why a follow-up costs what it does, in one short line ('' when unknown). */
export function priceNote(p: FollowUpPriceDto | null | undefined): string {
  if (!p) return '';
  switch (p.rule) {
    case 'waived':
      return 'Fee waived by your doctor';
    case 'free':
      return `Follow-ups within ${p.window_days} days of your consultation are free`;
    case 'percent':
      return `Follow-up price — ${p.discount_percent}% off the usual ${priceLabel(p.base_fee)} fee`;
    case 'full':
      return 'Follow-up price (the usual consultation fee)';
    case 'outside_window':
      return `Full fee — follow-up prices apply within ${p.window_days} days of your consultation`;
    default:
      return '';
  }
}
