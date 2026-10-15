import type { AppointmentDto } from '@supadoc/models';
import { detailsLink, isPast, nairaLabel, outcomeNote, phaseOf, statusBadge } from './appointment-status';

function appt(over: Partial<AppointmentDto> = {}): AppointmentDto {
  return {
    id: 'a1',
    patient_id: 'p1',
    specialist: { id: 's1', name: 'Dr Ada Obi', specialty: 'Cardiology' } as AppointmentDto['specialist'],
    scheduled_at: '2026-09-05T10:00:00Z',
    type: 'video',
    type_label: 'Video',
    status: 'pending',
    status_label: 'Pending',
    amount: '15000.00',
    payment_status: 'paid',
    created_at: '2026-09-01T10:00:00Z',
    ...over,
  };
}

describe('phaseOf / isPast', () => {
  it("uses the server's phase, whatever the status", () => {
    expect(phaseOf(appt({ status: 'pending', phase: 'past' }))).toBe('past');
    expect(isPast(appt({ status: 'confirmed', phase: 'past' }))).toBe(true);
    expect(isPast(appt({ status: 'confirmed', phase: 'live' }))).toBe(false);
  });

  it('falls back to the status for an older payload', () => {
    expect(phaseOf(appt({ status: 'missed' }))).toBe('past');
    expect(phaseOf(appt({ status: 'completed' }))).toBe('past');
    expect(phaseOf(appt({ status: 'pending' }))).toBe('upcoming');
  });
});

describe('statusBadge', () => {
  it("shows the server's label and detail for a missed visit", () => {
    const b = statusBadge(
      appt({ status: 'missed', display_status: 'missed', display_label: 'Missed', display_detail: "Doctor didn't attend" }),
    );
    expect(b.key).toBe('missed');
    expect(b.label).toBe('Missed');
    expect(b.detail).toBe("Doctor didn't attend");
    expect(b.icon).toBe('calendar-x');
  });

  it('renders a display status the app does not know yet as a neutral pill', () => {
    const b = statusBadge(
      appt({
        status: 'confirmed',
        display_status: 'on_hold' as unknown as AppointmentDto['display_status'],
        display_label: 'On hold',
      }),
    );
    expect(b.label).toBe('On hold');
    expect(b.class).toBe('bg-cloud text-slate');
    expect(b.icon).toBe('info');
  });

  it('colours an upcoming booking by its status', () => {
    const b = statusBadge(appt({ status: 'confirmed', display_status: 'upcoming', display_label: 'Confirmed' }));
    expect(b.key).toBe('upcoming');
    expect(b.class).toContain('text-sage');
    expect(b.detail).toBe('');
  });

  it('derives the key from the status when display_status is missing', () => {
    expect(statusBadge(appt({ status: 'cancelled', status_label: 'Cancelled' })).key).toBe('cancelled');
    expect(statusBadge(appt({ status: 'missed', status_label: 'Missed' })).label).toBe('Missed');
  });

  it("labels a past booking the doctor never confirmed 'Not confirmed'", () => {
    const b = statusBadge(
      appt({ status: 'pending', phase: 'past', display_status: 'not_confirmed', display_label: 'Not confirmed' }),
    );
    expect(b.key).toBe('not_confirmed');
    expect(b.label).toBe('Not confirmed');
  });
});

describe('detailsLink', () => {
  it('sends anything over to History, whatever its status', () => {
    expect(detailsLink(appt({ status: 'pending', phase: 'past' }))).toEqual(['/dashboard/history', 'a1']);
    expect(detailsLink(appt({ status: 'missed', phase: 'past' }))).toEqual(['/dashboard/history', 'a1']);
  });

  it('keeps upcoming and live ones in Appointments', () => {
    expect(detailsLink(appt({ status: 'confirmed', phase: 'upcoming' }))).toEqual(['/dashboard/appointments', 'a1']);
    expect(detailsLink(appt({ status: 'confirmed', phase: 'live' }))).toEqual(['/dashboard/appointments', 'a1']);
  });

  it('keeps a proposal (open or never taken up) on its appointment page', () => {
    expect(detailsLink(appt({ status: 'proposed', phase: 'past' }))).toEqual(['/dashboard/appointments', 'a1']);
    expect(
      detailsLink(appt({ status: 'cancelled', phase: 'past', proposed_by: 'doctor', payment_status: 'unpaid' })),
    ).toEqual(['/dashboard/appointments', 'a1']);
  });
});

describe('outcomeNote', () => {
  it('says what went back to the wallet for a doctor no-show', () => {
    const note = outcomeNote(appt({ status: 'missed', no_show: 'doctor', refunded_amount: '15000.00' }));
    expect(note).toContain("Your doctor didn't attend");
    expect(note).toContain('₦15,000.00 went back to your wallet.');
  });

  it('never claims a refund the payload does not show for a doctor no-show', () => {
    const note = outcomeNote(appt({ status: 'missed', no_show: 'doctor', refunded_amount: null }));
    expect(note).toBe("Your doctor didn't attend this consultation, so it was closed as missed.");
    expect(note).not.toContain('wallet');
  });

  it('explains a patient no-show without a refund', () => {
    const note = outcomeNote(appt({ status: 'missed', no_show: 'patient', refunded_amount: null }));
    expect(note).toBe("You didn't join this consultation, so it was closed as missed.");
  });

  it('explains a booking the doctor did not confirm in time', () => {
    const note = outcomeNote(
      appt({ status: 'cancelled', closure_reason: 'expired_unconfirmed', payment_status: 'refunded' }),
    );
    expect(note).toContain("didn't confirm this consultation in time");
    expect(note).toContain('₦15,000.00 went back to your wallet.');
  });

  it('never names the reason for the visit', () => {
    const note = outcomeNote(appt({ status: 'missed', no_show: 'both', notes: 'Chest pain' }));
    expect(note).not.toContain('Chest pain');
  });

  it('adds nothing for a completed visit', () => {
    expect(outcomeNote(appt({ status: 'completed' }))).toBe('');
  });
});

describe('nairaLabel', () => {
  it("formats money and drops zero / nothing", () => {
    expect(nairaLabel('2500')).toBe('₦2,500.00');
    expect(nairaLabel(0)).toBe('');
    expect(nairaLabel(null)).toBe('');
  });
});
