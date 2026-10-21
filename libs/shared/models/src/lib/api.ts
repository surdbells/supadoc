/**
 * Transport-level shapes for talking to the backend API.
 *
 * The backend is built by a separate team. Adjust these envelopes to match the
 * real contract once it is published — every app talks to the API through
 * `@supadoc/data-access`, which is typed against these shapes.
 */

/** Standard success envelope. Set `T` to the payload type. */
export interface ApiResponse<T> {
  data: T;
  message?: string;
}

/** Standard error envelope returned on non-2xx responses. */
export interface ApiError {
  statusCode: number;
  message: string;
  /** Optional field-level validation errors, keyed by field name. */
  errors?: Record<string, string>;
  /** From a `Retry-After` header (e.g. on a 429): how long to wait before trying again. */
  retryAfterMs?: number;
}

/**
 * The machine-readable reason a 401 carries in `errors.code` (with the human
 * message under `errors.auth`, first). An API without these codes sends none —
 * the client then treats any 401 on a signed-in request as "refresh and retry".
 *
 * - `token_missing` / `token_expired` / `token_invalid`: the access token is
 *   absent, past its short life or unreadable — refresh once and retry.
 * - `token_wrong_audience`: a patient token on a staff route (or the reverse) —
 *   a client bug, never refreshed.
 * - `session_expired` / `session_revoked` / `session_invalid`,
 *   `refresh_invalid`, `account_missing` / `account_deactivated`: the session
 *   is over — sign out now, with the server's message.
 * - `refresh_unavailable` (client only): a refresh failed for a transient
 *   reason (offline, 5xx, rate limited) — the user is still signed in.
 */
export type AuthErrorCode =
  | 'token_missing'
  | 'token_expired'
  | 'token_invalid'
  | 'token_wrong_audience'
  | 'session_expired'
  | 'session_revoked'
  | 'session_invalid'
  | 'refresh_invalid'
  | 'account_missing'
  | 'account_deactivated'
  | 'refresh_unavailable';

/** Cursor/offset pagination envelope. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Common query params for list endpoints. */
export interface PageQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  sort?: string;
}
