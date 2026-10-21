import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorCode, apiErrorMessage, DocumentSharingApi } from '@supadoc/data-access';
import type { CreateDocumentShareInput, DocumentShareResultDto, SharingAppointmentRefDto } from '@supadoc/models';
import { DialogComponent, IconComponent } from '@supadoc/ui';
import { drName, newKey, SHARING_CLASSES, SHARING_UNAVAILABLE, type SharingTheme } from './document-sharing';

/**
 * The call's one-tap share of a private document with this consultation's
 * doctor: "Share {title} with Dr X until 24 hours after this consultation?"
 * (or "for 24 hours" when that option isn't offered) → **Share** (one
 * request), **More options** (the full Share dialog), Cancel.
 */
@Component({
  selector: 'pat-share-confirm-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, IconComponent],
  template: `
    <sd-dialog
      [open]="open()"
      layout="plain"
      size="sm"
      labelledBy="share-sheet-title"
      [busy]="busy()"
      (closed)="close()"
      (afterClose)="closed.emit()"
    >
      <div class="flex flex-col gap-4 p-5 sm:p-6" [class]="c().body" [attr.aria-busy]="busy() || null">
        <div class="flex items-start justify-between gap-3">
          <h2 id="share-sheet-title" tabindex="-1" data-autofocus class="font-heading text-h5 outline-none wrap-anywhere" [class]="c().heading">{{ question() }}</h2>
          <button type="button" class="inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors" [class]="c().iconBtn" aria-label="Close" [disabled]="busy()" (click)="close()">
            <sd-icon name="x" [size]="22" />
          </button>
        </div>
        <p class="font-sans text-body-sm" [class]="c().muted">You can change or stop sharing at any time.</p>
        @if (error()) {
          <p class="flex items-start gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="unavailable() ? c().note : c().error" role="alert">
            <sd-icon [name]="unavailable() ? 'lock' : 'triangle-alert'" [size]="18" class="mt-0.5 shrink-0" />{{ error() }}
          </p>
        }
        <div class="flex flex-col gap-2">
          @if (!unavailable()) {
            <button type="button" class="inline-flex min-h-11 items-center justify-center gap-2 rounded-field py-3 font-sans text-body font-semibold transition-colors disabled:opacity-60" [class]="c().primary" [disabled]="busy()" (click)="share()">
              @if (busy()) { <sd-icon name="loader-circle" [size]="18" class="animate-spin" /> }
              {{ busy() ? 'Sharing…' : 'Share' }}
            </button>
            <button type="button" class="min-h-11 rounded-field py-3 font-sans text-body font-semibold transition-colors" [class]="c().secondary" [disabled]="busy()" (click)="moreOptions()">More options</button>
          }
          <button type="button" class="min-h-11 rounded-field py-3 font-sans text-body font-semibold transition-colors" [class]="c().link" [disabled]="busy()" (click)="close()">Cancel</button>
        </div>
      </div>
    </sd-dialog>
  `,
})
export class ShareConfirmSheet {
  private readonly sharing = inject(DocumentSharingApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly documentId = input.required<string>();
  readonly documentTitle = input.required<string>();
  readonly doctorId = input.required<string>();
  readonly doctorName = input.required<string>();
  /** This consultation (its `after_options`). */
  readonly appointment = input<SharingAppointmentRefDto | null>(null);
  readonly theme = input<SharingTheme>('call');

  readonly done = output<DocumentShareResultDto>();
  /** "More options": the host opens the full Share dialog. */
  readonly more = output<void>();
  readonly closed = output<void>();

  protected readonly c = computed(() => SHARING_CLASSES[this.theme()]);
  protected readonly open = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly unavailable = signal(false);
  private readonly key = newKey();

  /** Until 24 hours after this consultation when that's offered, else 24 hours. */
  private readonly afterOffered = computed(() => {
    const end = this.appointment()?.after_options.after_24h;
    return !!end && Date.parse(end) > Date.now() + 60 * 60_000;
  });
  protected readonly question = computed(
    () =>
      `Share ${this.documentTitle()} with ${drName(this.doctorName())} ${
        this.afterOffered() ? 'until 24 hours after this consultation' : 'for 24 hours'
      }?`,
  );

  protected close(): void {
    if (!this.busy()) this.open.set(false);
  }

  protected moreOptions(): void {
    this.more.emit();
    this.open.set(false);
  }

  protected share(): void {
    if (this.busy()) return;
    const after = this.afterOffered();
    const appt = this.appointment();
    const input: CreateDocumentShareInput = {
      specialist_ids: [this.doctorId()],
      scope: 'selected',
      document_ids: [this.documentId()],
      duration: after ? 'after_24h' : '24h',
      client_key: this.key,
      surface: 'call',
    };
    // The consultation only rides along when it anchors the end (as `shareInput`).
    if (after && appt) input.appointment_id = appt.id;
    this.busy.set(true);
    this.error.set('');
    this.sharing
      .share(input)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.done.emit(res.data);
          this.open.set(false);
        },
        error: (err: unknown) => {
          this.busy.set(false);
          if (apiErrorCode(err) === 'sharing_unavailable') {
            this.unavailable.set(true);
            this.error.set(SHARING_UNAVAILABLE);
            return;
          }
          this.error.set(apiErrorMessage(err, 'Could not share. Please try again.'));
        },
      });
  }
}
