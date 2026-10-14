import { apiErrorFields, apiErrorMessage } from '@supadoc/data-access';

/**
 * Which consultations this browser has already rated — a per-viewer
 * convenience so the rating card can say "thanks" instead of asking again. The
 * API is the authority (it refuses a second review); storage can be missing or
 * blocked, so every access is best-effort.
 */
const KEY = 'videomed.reviewed';

function read(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function wasReviewed(appointmentId: string): boolean {
  return appointmentId !== '' && read().includes(appointmentId);
}

export function rememberReviewed(appointmentId: string): void {
  if (appointmentId === '') return;
  try {
    // Newest last; a few hundred ids is plenty for a convenience hint.
    const ids = [...read().filter((id) => id !== appointmentId), appointmentId].slice(-200);
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable — the API still refuses a duplicate */
  }
}

/** The API's "You have already reviewed this consultation" (422, errors.rating). */
export function isAlreadyReviewed(err: unknown): boolean {
  return /already reviewed/i.test(apiErrorFields(err)['rating'] ?? '') || /already reviewed/i.test(apiErrorMessage(err, ''));
}
