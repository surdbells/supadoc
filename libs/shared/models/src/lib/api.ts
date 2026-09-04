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
}

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
