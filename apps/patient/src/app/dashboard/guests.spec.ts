import type { PatientGuestDto, PatientGuestListDto } from '@supadoc/models';
import {
  addGuestErrors,
  cleanGuestName,
  guestInitials,
  guestMoney,
  money,
  newGuestProblems,
  removalRefundNote,
  resendWait,
} from './guests';

function guest(over: Partial<PatientGuestDto> = {}): PatientGuestDto {
  return {
    id: 'g1',
    uid: 100,
    name: 'Sam Lee',
    email: 'sam@example.com',
    display_name: null,
    status: 'invited',
    in_call: false,
    fee: '2000.00',
    paid_by: 'wallet',
    invited_at: null,
    last_sent_at: null,
    resend_available_at: null,
    joined_at: null,
    consented_at: null,
    join_url: 'https://example.test/call/join/x',
    ...over,
  };
}

function list(over: Partial<PatientGuestListDto> = {}): PatientGuestListDto {
  return {
    guests: [guest()],
    max_guests: 3,
    guest_fee: '2000.00',
    currency: 'NGN',
    can_manage: true,
    can_add: true,
    manage_problem: null,
    refundable_until: '2026-10-14T10:00:00Z',
    window_closes_at: '2026-10-14T11:30:00Z',
    resend_interval_seconds: 120,
    ...over,
  };
}

describe('guest money', () => {
  it('a fee of 0 reads Free, a balance of 0 reads ₦0.00', () => {
    expect(guestMoney('0.00')).toBe('Free');
    expect(guestMoney('2000')).toBe('₦2,000.00');
    expect(money(0)).toBe('₦0.00');
    expect(money('1500.5', 'USD')).toBe('USD 1,500.50');
  });
});

describe('newGuestProblems', () => {
  it('needs a name and a valid email, and no one invited twice', () => {
    expect(newGuestProblems('', '', [])).toEqual({
      name: 'Enter the guest’s name',
      email: 'Enter the guest’s email address',
    });
    expect(newGuestProblems('Ann', 'not-an-email', []).email).toBe('Enter a valid email address');
    expect(newGuestProblems('Ann', 'SAM@example.com', [guest()]).email).toBe('This person is already invited');
    expect(newGuestProblems('A'.repeat(101), 'ann@example.com', []).name).toContain('100 characters');
    expect(newGuestProblems('Ann', 'ann@example.com', [guest()])).toEqual({});
  });

  it('collapses spaces in names', () => {
    expect(cleanGuestName('  Ann   Bee ')).toBe('Ann Bee');
    expect(guestInitials('Ann Marie Bee')).toBe('AB');
  });
});

describe('addGuestErrors', () => {
  it('puts field errors on their fields', () => {
    const e = addGuestErrors({ statusCode: 422, message: 'x', errors: { email: "That's your own email — invite someone else" } });
    expect(e.email).toBe("That's your own email — invite someone else");
    expect(e.general).toBe('');
    expect(e.stale).toBe(false);
  });

  it('gives flags words of their own', () => {
    expect(addGuestErrors({ statusCode: 422, errors: { wallet: 'insufficient_funds' } }).walletShort).toBe(true);
    const credited = addGuestErrors({
      statusCode: 422,
      errors: { guests: 'This consultation already has 3 guests', payment: 'credited_to_wallet' },
    });
    expect(credited.credited).toBe(true);
    expect(credited.stale).toBe(true);
    expect(credited.general).toContain('already has 3 guests');
    expect(credited.general).toContain('already has 3 guests. Your payment was returned to your wallet.');
    expect(credited.general).not.toContain('credited_to_wallet');
  });

  it('keeps a card payment for a retry after a hiccup, not after a refusal', () => {
    expect(addGuestErrors({ statusCode: 422, errors: { payment: 'Could not verify — please try again.' } }).paymentRefused).toBe('');
    expect(addGuestErrors({ statusCode: 422, errors: { payment_reference: 'This payment was already used' } }).paymentRefused).toBe(
      'This payment was already used',
    );
  });
});

describe('removalRefundNote', () => {
  const before = Date.parse('2026-10-14T09:00:00Z');
  const after = Date.parse('2026-10-14T10:30:00Z');

  it('refunds a paid fee before the start, not after', () => {
    expect(removalRefundNote(guest(), list(), before)).toBe('Their ₦2,000.00 guest fee will be refunded to your wallet.');
    expect(removalRefundNote(guest(), list(), after)).toContain('isn’t refunded');
  });

  it('says nothing for a free guest', () => {
    expect(removalRefundNote(guest({ fee: '0.00', paid_by: 'free' }), list(), before)).toBe('');
  });
});

describe('resendWait', () => {
  it('counts down to when the invitation can be re-sent', () => {
    const now = Date.parse('2026-10-14T09:00:00Z');
    expect(resendWait(guest({ resend_available_at: '2026-10-14T09:01:35Z' }), now)).toBe('1:35');
    expect(resendWait(guest({ resend_available_at: '2026-10-14T08:59:00Z' }), now)).toBe('');
    expect(resendWait(guest(), now)).toBe('');
  });
});
