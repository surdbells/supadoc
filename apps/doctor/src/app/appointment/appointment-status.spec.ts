import type { AppointmentDto } from '@supadoc/models';
import {
  canConfirm,
  isPast,
  lookFor,
  statusDetail,
  statusKey,
  statusOutcome,
} from './appointment-status';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 15, 12, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

function appt(over: Partial<AppointmentDto> = {}): AppointmentDto {
  return {
    id: 'a-1',
    patient_id: 'p-1',
    specialist: { id: 's-1', name: 'Dr Ada', specialty: 'GP' },
    scheduled_at: iso(NOW + 24 * HOUR),
    type: 'consultation',
    type_label: 'Video Consultation',
    status: 'confirmed',
    status_label: 'Confirmed',
    amount: '10000.00',
    notes: null,
    payment_status: 'paid',
    created_at: iso(NOW - 48 * HOUR),
    ...over,
  } as AppointmentDto;
}

describe('appointment status helpers', () => {
  it('styles a booking still to come by its status, and anything else by the lifecycle', () => {
    expect(statusKey(appt({ display_status: 'upcoming' }))).toBe('confirmed');
    expect(statusKey(appt({ status: 'pending', display_status: 'upcoming' }))).toBe('pending');
    expect(statusKey(appt({ status: 'pending', display_status: 'not_confirmed' }))).toBe('not_confirmed');
    expect(statusKey(appt({ status: 'missed', display_status: 'missed' }))).toBe('missed');
    // Older payloads: the status.
    expect(statusKey(appt({ status: 'completed' }))).toBe('completed');
    expect(lookFor('missed').icon).toBe('calendar-x');
    expect(lookFor('something-new').pill).toContain('bg-cloud');
  });

  it('shows the detail line unless it only repeats the badge', () => {
    expect(statusDetail(appt({ display_detail: "Patient didn't join" }), 'Missed')).toBe("Patient didn't join");
    expect(statusDetail(appt({ display_detail: 'Awaiting patient' }), 'Awaiting patient')).toBeNull();
    expect(statusDetail(appt({ display_detail: null }), 'Confirmed')).toBeNull();
  });

  it('decides what is over by the server phase, falling back on the clock', () => {
    expect(isPast(appt({ phase: 'past' }), NOW)).toBe(true);
    expect(isPast(appt({ phase: 'live', scheduled_at: iso(NOW - 2 * HOUR) }), NOW)).toBe(false);
    // A cancelled booking still in the future is over (it belongs to History).
    expect(isPast(appt({ status: 'cancelled' }), NOW)).toBe(true);
    // No lifecycle fields: ended (start + slot) more than 30 minutes before now.
    expect(isPast(appt({ scheduled_at: iso(NOW - 2 * HOUR), ends_at: iso(NOW - HOUR) }), NOW)).toBe(true);
    expect(isPast(appt({ scheduled_at: iso(NOW - HOUR), ends_at: iso(NOW - 20 * 60_000) }), NOW)).toBe(false);
    expect(isPast(appt(), NOW)).toBe(false);
  });

  it('re-checks an upcoming snapshot against the clock (a page left open)', () => {
    const loadedEarlier = appt({ phase: 'upcoming', scheduled_at: iso(NOW - 2 * HOUR), ends_at: iso(NOW - HOUR - 30 * 60_000) });
    expect(isPast(loadedEarlier, NOW)).toBe(true);
    // Still inside the 30-minute grace after its end: not over yet.
    expect(isPast({ ...loadedEarlier, ends_at: iso(NOW - 10 * 60_000) }, NOW)).toBe(false);
    expect(isPast(appt({ phase: 'upcoming' }), NOW)).toBe(false);
  });

  it('only offers Confirm on a request the API still takes', () => {
    expect(canConfirm(appt({ status: 'pending' }))).toBe(true);
    expect(canConfirm(appt({ status: 'rescheduled', can_confirm: true }))).toBe(true);
    expect(canConfirm(appt({ status: 'pending', can_confirm: false }))).toBe(false);
    expect(canConfirm(appt({ status: 'confirmed', can_confirm: true }))).toBe(false);
  });

  it('explains a missed consultation by who did not come, with any refund', () => {
    const missed = appt({ status: 'missed', display_status: 'missed', no_show: 'patient', refunded_amount: null });
    expect(statusOutcome(missed)).toMatchObject({ tone: 'warning', title: "Missed — the patient didn't join" });
    expect(statusOutcome(missed)?.text).toContain('counts towards your earnings');
    expect(statusOutcome({ ...missed, refunded_amount: '2500.00' })?.text).toMatch(/₦2,500\.00 of it was refunded/);
    expect(statusOutcome({ ...missed, no_show: 'doctor', refunded_amount: '10000.00' })).toMatchObject({
      tone: 'danger',
      title: "Missed — you didn't attend",
    });
    expect(statusOutcome({ ...missed, no_show: 'both' })?.title).toBe('Missed — neither of you joined');
    // Nothing was paid (e.g. a free follow-up): no refund is claimed.
    expect(statusOutcome({ ...missed, no_show: 'doctor', refunded_amount: null })?.text).toMatch(/^No fee is earned\./);
  });

  it('explains requests not confirmed in time and consultations being finalised; nothing otherwise', () => {
    expect(statusOutcome(appt({ status: 'cancelled', display_status: 'not_confirmed', refunded_amount: '10000.00' }))?.text).toMatch(
      /cancelled and the patient refunded ₦10,000\.00\./,
    );
    // Unpaid or free: nothing went back, so no refund is claimed.
    const unpaid = statusOutcome(appt({ status: 'cancelled', display_status: 'not_confirmed', refunded_amount: null }))?.text;
    expect(unpaid).toContain('nothing was charged');
    expect(unpaid).not.toContain('refunded');
    expect(statusOutcome(appt({ status: 'pending', display_status: 'not_confirmed' }))?.text).toContain('if anything was paid');

    const ended = statusOutcome(appt({ display_status: 'finalising' }));
    expect(ended?.title).toBe('Ended — being finalised');
    expect(ended?.text).toContain('mark it completed now');
    // A request never confirmed that both sides joined: the cron never expires it, so no
    // automatic refund is promised — completed on proof, otherwise reviewed by the team.
    const request = statusOutcome(appt({ status: 'pending', display_status: 'finalising' }))?.text;
    expect(request).toContain('but you both joined');
    expect(request).toContain('otherwise our team reviews it with the patient');
    expect(request).not.toContain('refunded');
    expect(request).not.toContain('mark it completed');
    expect(statusOutcome(appt({ display_status: 'upcoming' }))).toBeNull();
    expect(statusOutcome(appt({ status: 'completed', display_status: 'completed' }))).toBeNull();
  });
});
