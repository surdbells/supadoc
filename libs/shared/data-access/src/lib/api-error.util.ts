/**
 * Helpers for turning any thrown error into a user-facing message.
 *
 * The API error envelope is `{ status, message, errors: { field: msg } }`, where
 * `message` is often generic ("Validation failed") and the useful, specific text
 * lives in `errors`. These helpers prefer the specific field error, and work on
 * BOTH shapes an error can arrive in:
 *   - a normalised {@link ApiError} (after the http-error interceptor), or
 *   - a raw `HttpErrorResponse` whose parsed body sits under `.error`.
 * so a caller never has to know which one it holds.
 */

/** The default shown when an error carries no usable text at all. */
export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

/** Pull the raw `errors` map off either error shape. */
function rawErrors(err: unknown): unknown {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { errors?: unknown; error?: { errors?: unknown } | null };
  return e.errors ?? (e.error && typeof e.error === 'object' ? e.error.errors : undefined);
}

/** Pull the best top-level message, preferring the API body over transport noise. */
function topMessage(err: unknown): string | undefined {
  if (typeof err === 'string') return err.trim() || undefined;
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { message?: unknown; error?: { message?: unknown } | null };
  // The parsed API body (`.error.message` on a raw HttpErrorResponse) beats
  // Angular's transport message (`.message`, e.g. "Http failure response for …").
  const bodyMsg =
    e.error && typeof e.error === 'object' && typeof e.error.message === 'string'
      ? e.error.message
      : undefined;
  const topMsg = typeof e.message === 'string' ? e.message : undefined;
  return (bodyMsg?.trim() || topMsg?.trim()) || undefined;
}

/**
 * Field-level validation errors as a flat `{ field: message }` map (empty if
 * none). Values in the wire format may be a string or an array of strings; the
 * first non-empty string wins.
 */
export function apiErrorFields(err: unknown): Record<string, string> {
  const raw = rawErrors(err);
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
      const msg = Array.isArray(value)
        ? value.find((v): v is string => typeof v === 'string' && v.trim() !== '')
        : value;
      if (typeof msg === 'string' && msg.trim() !== '') out[field] = msg;
    }
  }
  return out;
}

/**
 * The single best human-facing message for a thrown error: the first specific
 * field error if any, otherwise the top-level API message, otherwise `fallback`.
 */
export function apiErrorMessage(err: unknown, fallback: string = GENERIC_ERROR_MESSAGE): string {
  const firstField = Object.values(apiErrorFields(err))[0];
  if (firstField) return firstField;
  return topMessage(err) ?? fallback;
}
