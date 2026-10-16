import type { ReferenceCategory } from '@supadoc/models';

/**
 * The back office's reference-data pick lists and the small, pure list logic
 * behind the Reference data page (search, move, duplicate check) — kept out of
 * the component so it is easy to test.
 */

/** One pick list as the page presents it. Add a row here when the API gains a category. */
export interface ReferenceListDef {
  readonly category: ReferenceCategory;
  /** Tab label, e.g. "Specialties". */
  readonly tab: string;
  /** Lower-case singular / plural nouns for sentences ("Add a specialty", "25 specialties"). */
  readonly one: string;
  readonly many: string;
  /** What records use an item ("doctor" → "12 doctors"). */
  readonly usedBy: string;
  readonly icon: string;
  /** One line under the page title for this list. */
  readonly about: string;
  /** Example for the "add" field. */
  readonly example: string;
  /**
   * The page listing the records that use an item, searched by its label
   * (`path?searchParam=label`), and the permission it needs — offered when an
   * item in use can't be deleted.
   */
  readonly usedByPage?: { readonly path: string; readonly searchParam: string; readonly permission: string };
}

export const REFERENCE_LISTS: readonly ReferenceListDef[] = [
  {
    category: 'specialty',
    tab: 'Specialties',
    one: 'specialty',
    many: 'specialties',
    usedBy: 'doctor',
    icon: 'stethoscope',
    about:
      "What doctors choose from during onboarding and what the back office offers on a new specialist. A doctor's specialty is saved as its name, so renaming one updates every doctor who has it.",
    example: 'e.g. Cardiology',
    // The doctor list's search covers the specialty.
    usedByPage: { path: '/specialists', searchParam: 'q', permission: 'specialists.manage' },
  },
];

/** The API's longest label. */
export const REFERENCE_LABEL_MAX = 120;

/** Which items to show: all, only the ones offered, or only the switched-off ones. */
export type ReferenceShow = 'all' | 'active' | 'inactive';

interface Labelled {
  readonly id: string;
  readonly label: string;
}

interface Listed extends Labelled {
  readonly code?: string;
  readonly active: boolean;
}

/**
 * A label compared the way the API compares it: case and runs of spaces
 * aside (the `label_key` the unique index is on).
 */
export function labelKey(label: string | null | undefined): string {
  return (label ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The label as it will be saved: trimmed, inner runs of spaces collapsed. */
export function tidyLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ');
}

/** The item already holding this label (any case / spacing), other than `exceptId`. */
export function duplicateOf<T extends Labelled>(items: readonly T[], label: string, exceptId?: string): T | null {
  const key = labelKey(label);
  if (key === '') return null;
  return items.find((i) => i.id !== exceptId && labelKey(i.label) === key) ?? null;
}

/** The items matching a search (label or code) and the active / switched-off choice, in list order. */
export function filterItems<T extends Listed>(items: readonly T[], q: string, show: ReferenceShow): T[] {
  const needle = labelKey(q);
  return items.filter((i) => {
    if (show === 'active' && !i.active) return false;
    if (show === 'inactive' && i.active) return false;
    if (needle === '') return true;
    return labelKey(i.label).includes(needle) || (i.code ?? '').toLowerCase().includes(needle.replace(/\s+/g, '-'));
  });
}

/**
 * The list with the item at `index` moved one place up (-1) or down (+1).
 * Out-of-range moves return an unchanged copy.
 */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const next = [...list];
  const to = index + delta;
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** "1 doctor", "12 doctors". */
export function countOf(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}

/** Capitalise the first letter ("specialty" → "Specialty"). */
export function capitalise(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}
