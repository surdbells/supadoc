/** Type guard that narrows out `null` and `undefined`. */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** True when the value is `null` or `undefined`. */
export function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** True for `null`, `undefined`, empty string, empty array or empty object. */
export function isEmpty(value: unknown): boolean {
  if (isNil(value)) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}
