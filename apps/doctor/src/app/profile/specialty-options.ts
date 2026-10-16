import type { PublicReferenceItemDto } from '@supadoc/models';

/** One choice in the speciality dropdown (`sd-search-select` options). */
export interface SpecialtyOption {
  /** What the form holds and the API receives. */
  readonly value: string;
  /** What the doctor sees. */
  readonly label: string;
}

/** Shown after a speciality the list no longer offers. */
export const RETIRED_SPECIALTY_SUFFIX = ' (no longer offered)';

/**
 * A speciality as the API compares it: trimmed, inner spaces collapsed, any
 * case (the API's `ReferenceItem::keyOf`).
 */
export function specialtyKey(label: string | null | undefined): string {
  return (label ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The doctor's own values, blanks dropped, one per speciality (first spelling wins). */
function ownValues(kept: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of kept) {
    const v = (raw ?? '').trim();
    if (v !== '' && !out.some((o) => specialtyKey(o) === specialtyKey(v)))
      out.push(v);
  }
  return out;
}

/**
 * The speciality dropdown's options: the list's active items in list order,
 * after the doctor's own values (`kept`: their current speciality, and one
 * asked for in a change request waiting for review) that the list no longer
 * offers — marked as such, so the doctor can keep them (the API keeps those).
 *
 * A kept value that matches an item in another case or spacing stands in for
 * that item's value, so leaving the choice alone sends back exactly what is
 * stored (no change for a reviewer, no unsaved-changes prompt).
 */
export function specialtyOptions(
  items: readonly PublicReferenceItemDto[],
  kept: readonly (string | null | undefined)[],
): SpecialtyOption[] {
  const own = ownValues(kept);
  const listed = new Set(items.map((i) => specialtyKey(i.label)));
  const retired = own
    .filter((v) => !listed.has(specialtyKey(v)))
    .map((v) => ({ value: v, label: `${v}${RETIRED_SPECIALTY_SUFFIX}` }));
  const active = items.map((i) => ({
    value:
      own.find((v) => specialtyKey(v) === specialtyKey(i.label)) ?? i.label,
    label: i.label,
  }));
  return [...retired, ...active];
}

/**
 * The value is a speciality the list no longer offers (switched off, or from
 * before the list). Never true while there is no list to compare with.
 */
export function isRetiredSpecialty(
  value: string | null | undefined,
  items: readonly PublicReferenceItemDto[],
): boolean {
  const key = specialtyKey(value);
  return (
    key !== '' &&
    items.length > 0 &&
    !items.some((i) => specialtyKey(i.label) === key)
  );
}
