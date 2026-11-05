import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { apiErrorCode, apiErrorMessage, LabRequestsApi } from '@supadoc/data-access';
import type { LabRequestDto, LabReviewOutcome } from '@supadoc/models';
import { DialogComponent } from '@supadoc/ui';
import type { Subscription } from 'rxjs';

export const NOTE_REQUIRED = 'Add a note for the patient';
const COMMENT_MIN = 3;
const COMMENT_MAX = 1000;

/** What the review dialog is about. */
export interface LabReviewTarget {
  readonly labId: string;
  readonly resultId: string;
  /** "{title} · {Covers}". */
  readonly subtitle: string;
  readonly outcome: LabReviewOutcome | null;
  readonly comment: string;
}

/**
 * "Review result": Normal / Abnormal and a note for the patient (required for
 * Abnormal). The patient sees the note, never the outcome. A 409 (the result
 * is no longer shared, or can't be opened) shows its message and asks the page
 * to reload the request.
 */
@Component({
  selector: 'doc-lab-review-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent],
  styles: `
    .rv-rd {
      width: 16px;
      height: 16px;
      accent-color: var(--color-cerulean);
    }
  `,
  template: `
    <sd-dialog [open]="open()" size="md" title="Review result" [subtitle]="target()?.subtitle ?? ''" [busy]="saving()" (closed)="closed.emit()">
      <div class="flex flex-col gap-5">
        <div class="flex flex-col gap-2">
          <span id="lab-review-result" class="font-sans text-body-sm font-semibold text-ink">Result</span>
          <div role="radiogroup" aria-labelledby="lab-review-result" class="flex gap-6">
            <label class="flex cursor-pointer items-center gap-2 font-sans text-body-sm text-ink">
              <input class="rv-rd" type="radio" name="lab-review-outcome" data-autofocus [checked]="outcome() === 'normal'" (change)="outcome.set('normal')" /> Normal
            </label>
            <label class="flex cursor-pointer items-center gap-2 font-sans text-body-sm text-ink">
              <input class="rv-rd" type="radio" name="lab-review-outcome" [checked]="outcome() === 'abnormal'" (change)="outcome.set('abnormal')" /> Abnormal
            </label>
          </div>
          @if (fieldError() === 'outcome') {
            <p class="font-sans text-caption text-alert-ink">Choose Normal or Abnormal</p>
          }
        </div>

        <div class="flex flex-col gap-1">
          <label for="lab-review-note" class="font-sans text-body-sm font-semibold text-ink">Note for the patient</label>
          <textarea
            id="lab-review-note"
            rows="4"
            class="min-h-24 w-full resize-y rounded-2xl border bg-white px-4 py-3 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20"
            [class]="fieldError() === 'comment' ? 'border-alert' : 'border-ash'"
            [maxLength]="max"
            [value]="comment()"
            [attr.aria-invalid]="fieldError() === 'comment' || null"
            aria-describedby="lab-review-help lab-review-count"
            (input)="comment.set($any($event.target).value)"
          ></textarea>
          <div class="flex items-start justify-between gap-3">
            <p id="lab-review-help" class="font-sans text-caption" [class]="fieldError() === 'comment' ? 'text-alert-ink' : 'text-slate'">
              {{ fieldError() === 'comment' ? noteRequired : 'The patient sees your note. They never see the words Normal or Abnormal.' }}
            </p>
            <p id="lab-review-count" class="shrink-0 font-sans text-caption text-slate">{{ comment().length }}/{{ max }}</p>
          </div>
        </div>

        @if (error()) {
          <p role="alert" class="rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-alert-ink">{{ error() }}</p>
        }

        <div class="flex flex-col-reverse justify-end gap-3 sm:flex-row">
          <button
            type="button"
            class="rounded-field border border-haze bg-white px-5 py-3 font-sans text-body-sm font-medium text-slate transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
            [disabled]="saving()"
            (click)="closed.emit()"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-field bg-cerulean px-5 py-3 font-sans text-body-sm font-medium text-white transition-colors hover:bg-cerulean-dark disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
            [disabled]="saving()"
            (click)="save()"
          >
            {{ saving() ? 'Saving…' : 'Save review' }}
          </button>
        </div>
      </div>
    </sd-dialog>
  `,
})
export class LabReviewDialog {
  private readonly api = inject(LabRequestsApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly open = input(false);
  readonly target = input<LabReviewTarget | null>(null);
  /** Saved: the updated request. */
  readonly saved = output<LabRequestDto>();
  /** A 409 said the request changed (not shared / not viewable / status): reload it. */
  readonly stale = output<void>();
  readonly closed = output<void>();

  protected readonly max = COMMENT_MAX;
  protected readonly noteRequired = NOTE_REQUIRED;
  protected readonly outcome = signal<LabReviewOutcome | null>(null);
  protected readonly comment = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly attempted = signal(false);
  private sub: Subscription | null = null;

  protected readonly fieldError = computed<'outcome' | 'comment' | null>(() => {
    if (!this.attempted()) return null;
    if (!this.outcome()) return 'outcome';
    if (this.outcome() === 'abnormal' && this.comment().trim().length < COMMENT_MIN) return 'comment';
    return null;
  });

  constructor() {
    effect(() => {
      const t = this.target();
      if (!this.open()) return;
      untracked(() => {
        this.outcome.set(t?.outcome ?? null);
        this.comment.set(t?.comment ?? '');
        this.error.set('');
        this.attempted.set(false);
      });
    });
    this.destroyRef.onDestroy(() => this.sub?.unsubscribe());
  }

  protected save(): void {
    const t = this.target();
    if (!t || this.saving()) return;
    this.attempted.set(true);
    if (this.fieldError()) return;
    const outcome = this.outcome() as LabReviewOutcome;
    const comment = this.comment().trim();
    this.saving.set(true);
    this.error.set('');
    this.sub = this.api.review(t.labId, t.resultId, comment ? { outcome, comment } : { outcome }).subscribe({
      next: (res) => {
        this.saving.set(false);
        this.saved.emit(res.data);
      },
      error: (err: unknown) => {
        this.saving.set(false);
        const code = apiErrorCode(err);
        this.error.set(apiErrorMessage(err, "Couldn't save the review. Try again."));
        if (code === 'not_viewable' || code === 'not_shared' || code === 'status_changed') this.stale.emit();
      },
    });
  }
}
