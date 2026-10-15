import type { ApiAppointmentStatus } from '@supadoc/models';
import {
  APPOINTMENT_STATUS_COLOR,
  APPOINTMENT_STATUS_LABEL,
  appointmentBadge,
  appointmentClosureLabel,
  appointmentPhase,
  appointmentStatusClass,
  appointmentStatusLabel,
  hasRefund,
  naira,
  refundableAmount,
} from './appointment-status';

const STATUSES: ApiAppointmentStatus[] = ['proposed', 'pending', 'confirmed', 'rescheduled', 'completed', 'cancelled', 'missed'];

describe('appointment-status', () => {
  it('words, colours and icons every status, missed included', () => {
    for (const s of STATUSES) {
      expect(APPOINTMENT_STATUS_LABEL[s]).not.toBe('');
      expect(APPOINTMENT_STATUS_COLOR[s]).toMatch(/^text-/);
      const b = appointmentBadge({ status: s, status_label: '' });
      expect(b.label).not.toBe('');
      expect(b.icon).not.toBe('');
    }
    expect(appointmentStatusLabel('missed')).toBe('Missed');
    expect(appointmentStatusLabel('no_such_status')).toBe('no such status');
    expect(appointmentStatusClass('no_such_status')).toBe('bg-cloud text-slate');
  });

  it("badges from the server's display fields, falling back to the status", () => {
    const missed = appointmentBadge({
      status: 'missed',
      status_label: 'Missed',
      display_status: 'missed',
      display_label: 'Missed',
      display_detail: "Doctor didn't attend",
    });
    expect(missed).toMatchObject({ label: 'Missed', icon: 'calendar-x', detail: "Doctor didn't attend", live: false });

    const live = appointmentBadge({ status: 'confirmed', status_label: 'Confirmed', display_status: 'live', display_label: 'In progress' });
    expect(live.live).toBe(true);
    expect(live.label).toBe('In progress');

    const notConfirmed = appointmentBadge({ status: 'pending', status_label: 'Pending', display_status: 'not_confirmed', display_label: 'Not confirmed' });
    expect(notConfirmed.label).toBe('Not confirmed');
    expect(notConfirmed.icon).toBe('calendar-off');

    // An older payload: no display fields.
    const legacy = appointmentBadge({ status: 'rescheduled', status_label: 'Rescheduled' });
    expect(legacy).toMatchObject({ label: 'Rescheduled', icon: 'calendar-clock', detail: null, live: false });
  });

  it('follows the server phase, else works it out from the time', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    expect(appointmentPhase({ status: 'pending', scheduled_at: '2026-09-01T10:00:00Z', phase: 'upcoming' }, now)).toBe('upcoming');
    expect(appointmentPhase({ status: 'cancelled', scheduled_at: '2026-12-01T10:00:00Z' }, now)).toBe('past');
    expect(appointmentPhase({ status: 'confirmed', scheduled_at: '2026-10-16T10:00:00Z' }, now)).toBe('upcoming');
    expect(appointmentPhase({ status: 'confirmed', scheduled_at: '2026-10-15T11:45:00Z', ends_at: '2026-10-15T12:15:00Z' }, now)).toBe('live');
    // 30 minutes of grace after the end, then past.
    expect(appointmentPhase({ status: 'confirmed', scheduled_at: '2026-10-15T11:00:00Z', ends_at: '2026-10-15T11:40:00Z' }, now)).toBe('live');
    expect(appointmentPhase({ status: 'confirmed', scheduled_at: '2026-10-15T10:00:00Z', ends_at: '2026-10-15T11:20:00Z' }, now)).toBe('past');
  });

  it("only offers back what was paid and hasn't gone back yet", () => {
    expect(refundableAmount({ amount: '15000.00', payment_status: 'paid' })).toBe(15000);
    expect(refundableAmount({ amount: '15000.00', payment_status: 'paid', refunded_amount: '5000.00' })).toBe(10000);
    expect(refundableAmount({ amount: '15000.00', payment_status: 'refunded', refunded_amount: '15000.00' })).toBe(0);
    // An older payload: `refunded` with no amount means all of it.
    expect(refundableAmount({ amount: '15000.00', payment_status: 'refunded' })).toBe(0);
    expect(refundableAmount({ amount: '15000.00', payment_status: 'unpaid' })).toBe(0);
    expect(refundableAmount({ amount: '0.00', payment_status: 'paid' })).toBe(0);
    expect(hasRefund({ refunded_amount: '0.00' })).toBe(false);
    expect(hasRefund({ refunded_amount: '1.50' })).toBe(true);
    expect(hasRefund({ refunded_amount: null })).toBe(false);
  });

  it('says how it closed, and claims a refund only when one happened', () => {
    // An unpaid or staff booking that lapsed: nothing went back.
    expect(appointmentClosureLabel({ closure_reason: 'expired_unconfirmed', refunded_amount: null })).toBe(
      "Closed automatically — the doctor didn't confirm in time",
    );
    expect(appointmentClosureLabel({ closure_reason: 'expired_unconfirmed', refunded_amount: '12500.00' })).toBe(
      "Closed automatically — the doctor didn't confirm in time (₦12,500.00 refunded)",
    );
    expect(appointmentClosureLabel({ closure_reason: 'no_show', refunded_amount: '0.00' })).toBe('Marked missed');
    expect(appointmentClosureLabel({ closure_reason: null })).toBe('—');
  });

  it('formats naira, and a dash for nothing', () => {
    expect(naira('12500')).toBe('₦12,500.00');
    expect(naira(null)).toBe('—');
    expect(naira('')).toBe('—');
    expect(naira('40', 'USD')).toBe('USD 40.00');
  });
});
