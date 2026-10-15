import { apiErrorFields, apiErrorMessage } from '@supadoc/data-access';
import type { PatientGuestDto, PatientGuestListDto, PatientGuestStatus } from '@supadoc/models';

/**
 * Shared bits of the patient's guest management — the Guests panel on the
 * appointment page and the in-call "Invite someone" dialog.
 */

/** invited → ready (accepted the notice in the lobby) → joined. Icon AND words, never colour alone. */
export const GUEST_STATUS: Record<PatientGuestStatus, { label: string; icon: string }> = {
  invited: { label: 'Invited', icon: 'mail' },
  consented: { label: 'Ready to join', icon: 'user-check' },
  joined: { label: 'Joined', icon: 'circle-check' },
};

/** The API's guest-name limit (the in-call name is shorter, set by the guest). */
export const GUEST_NAME_MAX = 100;
const GUEST_EMAIL_MAX = 190;

const NAIRA = new Intl.NumberFormat('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "₦5,000.00" (a balance: "₦0.00" too). */
export function money(value: string | number, currency = 'NGN'): string {
  const n = Number(value);
  return `${currency === 'NGN' ? '₦' : `${currency} `}${NAIRA.format(Number.isFinite(n) ? n : 0)}`;
}

/** A fee: "₦5,000.00", or "Free" when there is nothing to pay (never "₦0.00"). */
export function guestMoney(value: string | number, currency = 'NGN'): string {
  return Number(value) > 0 ? money(value, currency) : 'Free';
}

/** Nothing to pay for one more guest. */
export function guestIsFree(list: PatientGuestListDto | null): boolean {
  return !(Number(list?.guest_fee ?? 0) > 0);
}

/** Collapse spaces the way the API does. */
export function cleanGuestName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * What's wrong with a new guest before it is sent (the API checks the same
 * and more — the patient's own and the doctor's email).
 */
export function newGuestProblems(
  name: string,
  email: string,
  existing: readonly PatientGuestDto[],
): { name?: string; email?: string } {
  const out: { name?: string; email?: string } = {};
  if (!name) out.name = 'Enter the guest’s name';
  else if (name.length > GUEST_NAME_MAX) out.name = `Keep the name to ${GUEST_NAME_MAX} characters or fewer`;
  if (!email) out.email = 'Enter the guest’s email address';
  else if (email.length > GUEST_EMAIL_MAX || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    out.email = 'Enter a valid email address';
  } else if (existing.some((g) => g.email.trim().toLowerCase() === email.toLowerCase())) {
    out.email = 'This person is already invited';
  }
  return out;
}

/**
 * Field errors of a refused "add guest", in words. Flags (`wallet:
 * insufficient_funds`, `payment: credited_to_wallet`) get sentences of their
 * own; `general` is what to show above the form.
 */
export function addGuestErrors(err: unknown): {
  name?: string;
  email?: string;
  general: string;
  /** The wallet is short (reload the balance). */
  walletShort: boolean;
  /** A card payment for this guest went to the wallet instead. */
  credited: boolean;
  /** The list changed under us (full, closed) — reload it. */
  stale: boolean;
  /** The card payment itself was refused (not a hiccup to retry). */
  paymentRefused: string;
} {
  const fields = apiErrorFields(err);
  const flags = new Set(['wallet', 'payment', 'code']);
  const firstWords = Object.entries(fields).find(([k, v]) => !flags.has(k) || !/^[a-z_]+$/.test(v))?.[1];
  const walletShort = fields['wallet'] === 'insufficient_funds';
  const credited = fields['payment'] === 'credited_to_wallet';
  const payment = fields['payment_reference'] ?? (credited ? '' : (fields['payment'] ?? ''));
  let general = '';
  if (walletShort) {
    general = 'Your wallet balance is too low to pay the guest fee. Top up your wallet, or pay by card.';
  } else if (credited) {
    const lead = (firstWords ?? 'The guest couldn’t be added.').trim().replace(/([^.!?])$/, '$1.');
    general = `${lead} Your payment was returned to your wallet.`;
  } else if (!fields['name'] && !fields['email']) {
    general = firstWords ?? apiErrorMessage(err, 'Could not invite the guest. Please try again.');
  }
  return {
    name: fields['name'],
    email: fields['email'],
    general,
    walletShort,
    credited,
    stale: !!(fields['status'] || fields['guests']),
    paymentRefused: payment && !/try again/i.test(payment) ? payment : '',
  };
}

/**
 * Copy text to the clipboard. The async Clipboard API first; an off-screen
 * textarea + execCommand where it isn't available (older browsers, http).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Two-letter initials for a guest's avatar. */
export function guestInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words[words.length - 1][0] ?? '') : '')).toUpperCase() || '?';
}

/** "4:05" until the invitation can be re-sent ('' once it can). */
export function resendWait(guest: PatientGuestDto, now: number): string {
  const at = guest.resend_available_at ? Date.parse(guest.resend_available_at) : NaN;
  if (!Number.isFinite(at) || at <= now) return '';
  const s = Math.ceil((at - now) / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

/** What removing a guest gives back — said before the patient confirms. */
export function removalRefundNote(guest: PatientGuestDto, list: PatientGuestListDto, now: number): string {
  const fee = Number(guest.fee);
  if (!(fee > 0) || guest.paid_by === 'free') return '';
  const money = guestMoney(guest.fee, list.currency);
  const until = Date.parse(list.refundable_until);
  return Number.isFinite(until) && now < until
    ? `Their ${money} guest fee will be refunded to your wallet.`
    : `The consultation has started, so their ${money} guest fee isn’t refunded.`;
}
