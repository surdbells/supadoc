import { computed, type Signal, signal } from '@angular/core';
import type { ApplicationDocumentDto, ApplicationDocumentSlot } from '@supadoc/models';
import type { StepSource } from '../core/step-source';
import { bannerMessage } from '../core/errors';

/**
 * Which errors a form shows (spec §6.7): a field's error appears after it is
 * left (blur) or after a primary click; server 422 errors show at once and
 * clear when that field is edited.
 */
export class FormState {
  private readonly touchedSet = signal<ReadonlySet<string>>(new Set());
  readonly submitted = signal(false);
  readonly server = signal<Record<string, string>>({});

  constructor(private readonly client: Signal<Record<string, string>>) {}

  /** Every current error (client rules, then server answers). */
  readonly all = computed(() => ({ ...this.client(), ...this.server() }));
  readonly invalid = computed(() => Object.keys(this.all()).length > 0);

  touch(field: string): void {
    if (this.touchedSet().has(field)) return;
    this.touchedSet.update((s) => new Set([...s, field]));
  }

  /** The error to show for `field` now, or null. */
  shown(field: string): string | null {
    const server = this.server()[field];
    if (server) return server;
    if (!this.submitted() && !this.touchedSet().has(field)) return null;
    return this.client()[field] ?? null;
  }

  /** The field changed: its server error no longer applies. */
  edited(field: string): void {
    if (!(field in this.server())) return;
    this.server.update((s) => {
      const next = { ...s };
      delete next[field];
      return next;
    });
  }

  setServer(errors: Record<string, string>): void {
    this.server.set(errors);
  }

  /** Show every error; returns how many there are. */
  reveal(): number {
    this.submitted.set(true);
    return Object.keys(this.all()).length;
  }

  reset(): void {
    this.submitted.set(false);
    this.server.set({});
    this.touchedSet.set(new Set());
  }
}

/** Moves focus to the first field (in `order`) that has an error; `idOf` maps a key to its element id. */
export function focusFirstInvalid(
  order: readonly string[],
  errors: Record<string, string>,
  idOf: (key: string) => string = (k) => k,
): void {
  const key = order.find((k) => errors[k]) ?? Object.keys(errors)[0];
  if (!key) return;
  const el = document.getElementById(idOf(key));
  el?.focus();
  el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
}

export const UPLOAD_REQUIRED = 'Add this document to continue.';

/** Per-slot upload progress and errors for a step's file fields. */
export class SlotUploads {
  readonly progress = signal<Record<string, number>>({});
  readonly errors = signal<Record<string, string>>({});

  constructor(private readonly source: () => StepSource) {}

  key(slot: ApplicationDocumentSlot, label?: string | null): string {
    return slot === 'additional' && label ? `additional:${label}` : slot;
  }

  progressOf(key: string): number | null {
    return this.progress()[key] ?? null;
  }

  errorOf(key: string): string | null {
    return this.errors()[key] ?? null;
  }

  /** Requires the `required` keys to have no error yet: set by the page on Continue. */
  setError(key: string, message: string | null): void {
    this.errors.update((e) => {
      const next = { ...e };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });
  }

  pick(slot: ApplicationDocumentSlot, file: File, label?: string | null): void {
    const key = this.key(slot, label);
    this.setError(key, null);
    this.progress.update((p) => ({ ...p, [key]: 0 }));
    this.source()
      .upload(slot, file)
      .subscribe({
        next: (event) => {
          if ('progress' in event) this.progress.update((p) => ({ ...p, [key]: event.progress }));
        },
        error: (err: unknown) => {
          this.clearProgress(key);
          this.setError(key, bannerMessage(err, "We couldn't upload that file. Please try again."));
        },
        complete: () => this.clearProgress(key),
      });
  }

  async remove(doc: ApplicationDocumentDto): Promise<void> {
    const key = this.key(doc.slot, doc.label);
    this.setError(key, null);
    try {
      await this.source().removeDocument(doc);
    } catch (err) {
      this.setError(key, bannerMessage(err, "We couldn't remove that file. Please try again."));
    }
  }

  busy(): boolean {
    return Object.keys(this.progress()).length > 0;
  }

  private clearProgress(key: string): void {
    this.progress.update((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });
  }
}
