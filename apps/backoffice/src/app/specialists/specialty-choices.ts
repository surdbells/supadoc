import { inject, Injectable, signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import { ReferenceApi } from '@supadoc/data-access';
import type { ReferenceItemDto } from '@supadoc/models';
import { labelKey } from '../reference-data/reference-list';

/**
 * Where the specialty list stands:
 * - `loading` — first read in flight;
 * - `ready` — items to choose from;
 * - `empty` — the list has no items yet (the API then still takes any
 *   non-blank specialty — the gap between a deploy and its migration), so the
 *   form falls back to free text;
 * - `failed` — it could not be read; the form falls back to free text and
 *   offers a retry (the API still checks the value).
 */
export type SpecialtyListState = 'loading' | 'ready' | 'empty' | 'failed';

export interface SpecialtyOption {
  readonly value: string;
  readonly label: string;
}

/** What a specialty dropdown should offer for a given current value. */
export interface SpecialtyField {
  /** The active items, in list order — plus the current value first when it isn't one of them. */
  readonly options: readonly SpecialtyOption[];
  /** The value to show as selected: the active item's own spelling when the current value matches one. */
  readonly value: string;
  /** The current value is an item that has since been switched off. */
  readonly currentInactive: boolean;
  /** The current value is not on the list at all (an older free-text entry). */
  readonly currentUnlisted: boolean;
}

type Item = Pick<ReferenceItemDto, 'label' | 'active'>;

/**
 * The dropdown for `current`: only active items can be picked, but a doctor's
 * existing specialty that was switched off (or predates the list) is still
 * shown — marked as such — so it is kept until someone changes it.
 */
export function specialtyField(items: readonly Item[], current: string | null | undefined): SpecialtyField {
  const active = items.filter((i) => i.active);
  const options: SpecialtyOption[] = active.map((i) => ({ value: i.label, label: i.label }));
  const now = (current ?? '').trim();
  const key = labelKey(now);
  if (key === '') return { options, value: '', currentInactive: false, currentUnlisted: false };
  const match = active.find((i) => labelKey(i.label) === key);
  if (match) return { options, value: match.label, currentInactive: false, currentUnlisted: false };
  const inactive = items.some((i) => !i.active && labelKey(i.label) === key);
  const note = inactive ? 'switched off' : 'not on the list';
  return {
    options: [{ value: now, label: `${now} (${note})` }, ...options],
    value: now,
    currentInactive: inactive,
    currentUnlisted: !inactive,
  };
}

/** True when `value` is an active item's label (any case / spacing) — what the API accepts. */
export function isActiveSpecialty(items: readonly Item[], value: string | null | undefined): boolean {
  const key = labelKey(value);
  return key !== '' && items.some((i) => i.active && labelKey(i.label) === key);
}

/**
 * The specialty pick list for the back office's specialist forms (New
 * specialist, the doctor page's Overview), read from
 * `GET /api/reference/specialty` — staff with `specialists.manage` may read it.
 * `load()` re-reads it each time a form opens, so an item just added or
 * renamed under Reference data shows up; what was loaded stays on screen
 * while it refreshes.
 */
@Injectable({ providedIn: 'root' })
export class SpecialtyChoices {
  private readonly api = inject(ReferenceApi);
  private sub?: Subscription;

  /** Every item (active or not), in list order. */
  readonly items = signal<readonly ReferenceItemDto[]>([]);
  readonly state = signal<SpecialtyListState>('loading');

  load(): void {
    this.sub?.unsubscribe();
    if (this.items().length === 0) this.state.set('loading');
    this.sub = this.api.list('specialty').subscribe({
      next: (res) => {
        const list = [...(res.data ?? [])].sort((a, b) => a.sort_order - b.sort_order);
        this.items.set(list);
        this.state.set(list.length > 0 ? 'ready' : 'empty');
      },
      error: () => {
        // Keep a list we already have; otherwise fall back to free text.
        this.state.set(this.items().length > 0 ? 'ready' : 'failed');
      },
    });
  }
}
