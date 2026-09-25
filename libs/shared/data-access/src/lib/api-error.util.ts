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

/** Shown when no HTTP response reached us (offline, DNS, CORS, server down). */
export const NETWORK_ERROR_MESSAGE =
  "We couldn't reach the server. Check your internet connection and try again.";

/** Shown for a 5xx with no useful body text. */
export const SERVER_ERROR_MESSAGE =
  'The server ran into a problem. Please try again in a moment.';

/** Angular's transport-layer message — never useful to a person, so we hide it. */
const TRANSPORT_NOISE = /^Http failure response/i;

/** The API's opaque production 500 body — replace with a friendlier 5xx message. */
const GENERIC_SERVER_TEXT = /^(internal server error|unexpected server error)$/i;

/** The HTTP status, from either error shape (`ApiError.statusCode` or `HttpErrorResponse.status`). */
function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
}

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
 * The single best human-facing message for a thrown error. In priority order:
 *   1. a friendly connectivity message when no response reached us (status 0),
 *   2. the first specific field-level validation error,
 *   3. a meaningful top-level API message (ignoring Angular transport noise),
 *   4. a friendly server-error message for a 5xx with no useful body,
 *   5. the caller's contextual `fallback`.
 * This guarantees a screen never shows a raw technical string like
 * "Http failure response for …" or a bare "Unexpected server error".
 */
export function apiErrorMessage(err: unknown, fallback: string = GENERIC_ERROR_MESSAGE): string {
  const status = extractStatus(err);

  // No HTTP response at all — offline, DNS, CORS, or the API is down.
  if (status === 0) return NETWORK_ERROR_MESSAGE;

  // A specific field error is the most useful thing we can show.
  const firstField = Object.values(apiErrorFields(err))[0];
  if (firstField) return firstField;

  // A real message from the API body — never Angular's transport noise, and never
  // the opaque "Internal server error" (we say something friendlier for that).
  const top = topMessage(err);
  if (top && !TRANSPORT_NOISE.test(top) && !GENERIC_SERVER_TEXT.test(top)) {
    return top;
  }

  // The server failed without a usable message.
  if (typeof status === 'number' && status >= 500) return SERVER_ERROR_MESSAGE;

  return fallback;
}
