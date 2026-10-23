import { apiErrorCode, apiErrorFields, apiErrorMessage } from '@supadoc/data-access';

/** Shown for any 429 (spec §6.7). */
export const TOO_MANY_REQUESTS = 'Too many requests. Please wait a moment and try again.';

/** The HTTP status of either error shape, or 0. */
export function errorStatus(err: unknown): number {
  if (!err || typeof err !== 'object') return 0;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return 0;
}

/** Codes that end the draft session (the interceptor already dropped the token). */
export const DRAFT_ENDED = new Set(['applicant_token_invalid', 'draft_not_found', 'draft_submitted']);

/** Codes carried beside the message that are not field errors. */
const NOT_FIELDS = new Set(['code', 'reference', 'steps', 'items', 'attempts_left', 'retry_after']);

/** 422 field errors (snake_case keys, `entries.{i}.{field}`), without the machine tags. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (errorStatus(err) !== 422 || apiErrorCode(err)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(apiErrorFields(err))) if (!NOT_FIELDS.has(k)) out[k] = v;
  return out;
}

/** The banner message for an error: 429 has its own wording. */
export function bannerMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  // A plain per-IP limit has no code; coded 429s (resume_locked, resend_cooldown,
  // the daily code cap) carry their own wording.
  if (errorStatus(err) === 429 && !apiErrorCode(err)) return TOO_MANY_REQUESTS;
  return apiErrorMessage(err, fallback);
}

/** Retry-After as ms (ApiError.retryAfterMs), if the server sent one. */
export function retryAfterMs(err: unknown): number | null {
  const ms = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof ms === 'number' && ms > 0 ? ms : null;
}

export { apiErrorCode };
