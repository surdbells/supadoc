import type { ISODateString } from '@supadoc/models';

/** Convert a `Date` to an ISO-8601 string the API understands. */
export function toIsoDate(date: Date): ISODateString {
  return date.toISOString();
}

/** Parse an ISO-8601 string into a `Date` (or `null` if invalid). */
export function parseIsoDate(
  value: ISODateString | null | undefined,
): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Full name helper used across the portals. */
export function fullName(person: {
  firstName: string;
  lastName: string;
}): string {
  return `${person.firstName} ${person.lastName}`.trim();
}
