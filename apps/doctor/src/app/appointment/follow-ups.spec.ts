import type { ActivatedRouteSnapshot, Route } from '@angular/router';
import type { AppointmentDto } from '@supadoc/models';
import { DoctorRouteReuseStrategy } from '../route-reuse';
import {
  AWAITING_PATIENT,
  doctorStatusLabel,
  followUpPriceLabel,
  followUpState,
  isClosedProposal,
  isOpenProposal,
  moneyLabel,
  PROPOSAL_ALREADY_CLOSED,
  proposalExpiry,
  withdrewProposal,
} from './follow-ups';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 14, 12, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

function appt(over: Partial<AppointmentDto> = {}): AppointmentDto {
  return {
    id: 'fu-1',
    patient_id: 'p-1',
    specialist: { id: 's-1', name: 'Dr Ada', specialty: 'GP' },
    scheduled_at: iso(NOW + 48 * HOUR),
    type: 'follow_up',
    type_label: 'Follow-up Consultation',
    status: 'proposed',
    status_label: 'Proposed',
    amount: '5000.00',
    notes: null,
    payment_status: 'unpaid',
    parent_appointment_id: 'parent-1',
    proposed_by: 'doctor',
    expires_at: iso(NOW + 24 * HOUR),
    created_at: iso(NOW - HOUR),
    ...over,
  } as AppointmentDto;
}

describe('follow-up helpers', () => {
  it('a proposal is open until it expires', () => {
    expect(isOpenProposal(appt(), NOW)).toBe(true);
    expect(isOpenProposal(appt({ expires_at: iso(NOW - 1) }), NOW)).toBe(false);
    expect(isOpenProposal(appt({ status: 'confirmed' }), NOW)).toBe(false);
  });

  it('a proposal closes 2h before it starts, and at most 72h after it was made', () => {
    expect(proposalExpiry(NOW + 10 * HOUR, NOW)).toBe(NOW + 8 * HOUR);
    expect(proposalExpiry(NOW + 200 * HOUR, NOW)).toBe(NOW + 72 * HOUR);
  });

  it('lists name a proposal "Awaiting patient", and keep the API label otherwise', () => {
    expect(doctorStatusLabel(appt(), NOW)).toBe(AWAITING_PATIENT);
    expect(doctorStatusLabel(appt({ expires_at: iso(NOW - 1) }), NOW)).toBe('Expired');
    expect(doctorStatusLabel(appt({ status: 'confirmed', status_label: 'Confirmed', payment_status: 'paid' }), NOW)).toBe('Confirmed');
    expect(doctorStatusLabel(appt({ proposed_by: null, status: 'cancelled', status_label: 'Cancelled' }), NOW)).toBe('Cancelled');
  });

  it('tells how a closed proposal closed, as far as the payload says', () => {
    const closed = appt({ status: 'cancelled', status_label: 'Cancelled' });
    expect(followUpState(closed, NOW).label).toBe('Not accepted');
    expect(followUpState({ ...closed, decline_reason: 'Travelling' }, NOW).label).toBe('Declined');
    expect(followUpState(closed, NOW, new Set(['fu-1'])).label).toBe('Withdrawn');
    // The patient's decline beat the doctor's Withdraw: their reason says how it closed.
    expect(followUpState({ ...closed, decline_reason: 'Travelling' }, NOW, new Set(['fu-1'])).label).toBe('Declined');
    // Accepted (and so paid), then cancelled.
    expect(followUpState({ ...closed, payment_status: 'refunded' }, NOW).label).toBe('Cancelled');
    expect(followUpState(appt(), NOW)).toMatchObject({ open: true, tone: 'warning' });
  });

  it('says how a proposal closed when the API recorded it, before guessing', () => {
    const closed = appt({ status: 'cancelled', status_label: 'Cancelled' });
    expect(followUpState({ ...closed, follow_up_outcome: 'declined' }, NOW).label).toBe('Declined');
    expect(followUpState({ ...closed, follow_up_outcome: 'withdrawn' }, NOW).label).toBe('Withdrawn');
    expect(followUpState({ ...closed, follow_up_outcome: 'expired' }, NOW).label).toBe('Expired');
    // The record wins over this session's guess (the patient's decline beat the Withdraw).
    expect(followUpState({ ...closed, follow_up_outcome: 'declined' }, NOW, new Set(['fu-1'])).label).toBe('Declined');
    expect(doctorStatusLabel({ ...closed, follow_up_outcome: 'expired' }, NOW)).toBe('Expired');
    expect(isClosedProposal({ ...closed, follow_up_outcome: 'withdrawn', payment_status: 'paid' })).toBe(true);
  });

  it('a closed proposal is one the patient never accepted', () => {
    const closed = appt({ status: 'cancelled', status_label: 'Cancelled' });
    expect(isClosedProposal(closed)).toBe(true);
    expect(isClosedProposal(appt())).toBe(false);
    expect(isClosedProposal({ ...closed, payment_status: 'refunded' })).toBe(false);
    expect(isClosedProposal({ ...closed, proposed_by: 'patient' })).toBe(false);
  });

  it('labels past bookings by the lifecycle, not the status', () => {
    const booked = { proposed_by: null, payment_status: 'paid' as const };
    // A pending request whose time passed: "Not confirmed", never "Pending".
    expect(
      doctorStatusLabel(appt({ ...booked, status: 'pending', status_label: 'Pending', display_status: 'not_confirmed', display_label: 'Not confirmed' }), NOW),
    ).toBe('Not confirmed');
    // Cancelled by the closer for it (closure_reason expired_unconfirmed), even an unpaid doctor proposal shape.
    expect(
      doctorStatusLabel(appt({ status: 'cancelled', status_label: 'Cancelled', display_status: 'not_confirmed', display_label: 'Not confirmed' }), NOW),
    ).toBe('Not confirmed');
    expect(
      doctorStatusLabel(appt({ ...booked, status: 'confirmed', status_label: 'Confirmed', display_status: 'finalising', display_label: 'Being finalised' }), NOW),
    ).toBe('Being finalised');
    // Older payloads without the lifecycle fields keep the status label.
    expect(doctorStatusLabel(appt({ ...booked, status: 'confirmed', status_label: 'Confirmed' }), NOW)).toBe('Confirmed');
  });

  it('a missed follow-up says who did not come', () => {
    const missed = appt({
      proposed_by: 'patient',
      payment_status: 'paid',
      status: 'missed',
      status_label: 'Missed',
      display_status: 'missed',
      display_label: 'Missed',
      display_detail: "Patient didn't join",
      no_show: 'patient',
    });
    expect(followUpState(missed, NOW)).toMatchObject({ label: "Missed — patient didn't join", icon: 'calendar-x', tone: 'warning', open: false });
    expect(followUpState({ ...missed, no_show: 'doctor', display_detail: "You didn't attend" }, NOW)).toMatchObject({
      label: "Missed — you didn't attend",
      tone: 'danger',
    });
    expect(followUpState({ ...missed, display_detail: null }, NOW).label).toBe('Missed');
  });

  it('an open follow-up booking that is over reads as the lifecycle says', () => {
    const booked = appt({ proposed_by: 'patient', payment_status: 'paid', status: 'confirmed', status_label: 'Confirmed' });
    expect(followUpState(booked, NOW).label).toBe('Confirmed');
    expect(followUpState({ ...booked, display_status: 'live' }, NOW).label).toBe('In progress');
    expect(followUpState({ ...booked, display_status: 'finalising' }, NOW).label).toBe('Being finalised');
    expect(followUpState({ ...booked, status: 'pending', display_status: 'not_confirmed' }, NOW).label).toBe('Not confirmed in time');
  });

  it('a Withdraw that found the proposal already closed is not a withdrawal', () => {
    expect(withdrewProposal({ message: 'Follow-up withdrawn' })).toBe(true);
    expect(withdrewProposal({ message: PROPOSAL_ALREADY_CLOSED })).toBe(false);
  });

  it('prices read "Free" at 0 and carry the rule', () => {
    expect(moneyLabel('0.00')).toBe('Free');
    expect(moneyLabel('5000')).toMatch(/^₦5,000\.00$/);
    const priced = appt({
      follow_up_pricing: {
        base_fee: '10000.00',
        amount: '5000.00',
        rule: 'percent',
        discount_percent: 50,
        window_days: 14,
        window_ends_at: iso(NOW + 14 * 24 * HOUR),
        waived: false,
      },
    });
    expect(followUpPriceLabel(priced)).toBe('₦5,000.00 · 50% follow-up discount');
  });
});

describe('DoctorRouteReuseStrategy', () => {
  const strategy = new DoctorRouteReuseStrategy();
  const record: Route = { path: 'appointments/:id', data: { remountOnParamChange: true } };
  const other: Route = { path: 'patients/:id' };
  const snap = (routeConfig: Route, id: string) =>
    ({ routeConfig, params: { id } }) as unknown as ActivatedRouteSnapshot;

  it('re-creates the record page when its id changes', () => {
    expect(strategy.shouldReuseRoute(snap(record, 'b'), snap(record, 'a'))).toBe(false);
    expect(strategy.shouldReuseRoute(snap(record, 'a'), snap(record, 'a'))).toBe(true);
  });

  it('leaves other routes to the default', () => {
    expect(strategy.shouldReuseRoute(snap(other, 'b'), snap(other, 'a'))).toBe(true);
    expect(strategy.shouldReuseRoute(snap(other, 'a'), snap(record, 'a'))).toBe(false);
  });
});
