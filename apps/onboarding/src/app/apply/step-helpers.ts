import { DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { AbstractControl, FormGroup } from '@angular/forms';
import type { FormState } from '../shared/form-state';

/** Clears a field's server error as soon as it is edited. */
export function trackEdits(group: FormGroup, form: FormState, destroyRef: DestroyRef, prefix = ''): void {
  for (const [name, control] of Object.entries(group.controls as Record<string, AbstractControl>)) {
    control.valueChanges.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => form.edited(`${prefix}${name}`));
  }
}

/** '' → null, other strings trimmed. */
export function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

/** Strings as they are, anything else as ''. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

/** A whole number, or null. */
export function intOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}
