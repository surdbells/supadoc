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
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { CancelPrescriptionResult, PrescriptionSummaryDto } from '@supadoc/models';
import {
  AlertComponent,
  ButtonComponent,
  ConfirmDialogComponent,
  IconComponent,
} from '@supadoc/ui';
import { map, Observable, Subscription } from 'rxjs';
import { RxCancelForm } from './rx-cancel-form';
import { RxComposer } from './rx-composer';
import { RxFiles } from './rx-files';
import {
  medicinesLabel,
  RX_ACTION,
  RX_ACTION_DANGER,
  rxDate,
  RxStatusBadge,
} from './rx-shared';
import { CanLeave, LeavePrompt } from './unsaved-changes.guard';

/**
 * A consultation's prescriptions (or, without an appointment, this doctor's
 * prescriptions for the patient) with the composer built in: new / continue a
 * draft, delete drafts, view / download PDFs, cancel (and replace) active ones.
 *
 * Usage: `<doc-rx-panel [patientId]="pid" [appointmentId]="aid" [compact]="true" (changed)="…" />`.
 *
 * Unsaved work: the composer's form lives inside this panel, so a host must not
 * destroy the panel (switch tab, navigate away, end a call) without asking.
 * Either keep it mounted and hide it, or check first:
 * `if (!(await (this.rxPanel()?.canLeave() ?? true))) return;` — `canLeave()`
 * asks with the panel's own dialog (the panel must be on screen); a host that
 * hides the panel should ask with its own dialog using `hasUnsavedChanges()`.
 */
@Component({
  selector: 'doc-rx-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    ButtonComponent,
    ConfirmDialogComponent,
    IconComponent,
    RxCancelForm,
    RxComposer,
    RxStatusBadge,
  ],
  host: { class: 'block' },
  template: `
    @if (composing()) {
      <doc-rx-composer
        [patientId]="patientId()"
        [appointmentId]="appointmentId()"
        [prescriptionId]="composerId()"
        [compact]="compact()"
        [inCall]="inCall()"
        [disabled]="disabled()"
        (saved)="onSaved()"
        (sent)="onSent()"
        (closed)="closeComposer()"
      />
    } @else {
      <section class="flex flex-col gap-4" aria-label="Prescriptions">
        <header
          class="flex gap-3"
          [class]="compact() ? 'flex-col' : 'flex-col sm:flex-row sm:items-center sm:justify-between'"
        >
          <div class="flex min-w-0 flex-col gap-0.5">
            <h2 class="flex items-center gap-2 font-heading text-body-lg text-ink">
              <sd-icon name="pill" [size]="18" class="text-cerulean" /> Prescriptions
            </h2>
            <p class="font-sans text-caption text-slate">
              {{ appointmentId() ? 'Written during this consultation.' : 'Written by you for this patient.' }}
            </p>
          </div>
          <sd-button size="sm" [full]="compact()" [disabled]="disabled()" (click)="newPrescription()">
            <sd-icon name="plus" [size]="16" /> New prescription
          </sd-button>
        </header>

        @if (actionError()) {
          <sd-alert tone="error">{{ actionError() }}</sd-alert>
        } @else if (notice()) {
          <sd-alert tone="success">{{ notice() }}</sd-alert>
        }
        @if (blockedPdf(); as b) {
          <!-- The browser blocked the new tab; this page must not be left (e.g. a live call). -->
          <p class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-field bg-frost/50 px-4 py-3 font-sans text-body-sm text-ink" role="status">
            <sd-icon name="info" [size]="16" class="shrink-0 text-cerulean" />
            <span>Your browser blocked the new tab for {{ b.number }}.</span>
            <a
              class="inline-flex items-center gap-1 font-semibold text-cerulean underline"
              [href]="b.url"
              target="_blank"
              rel="noopener noreferrer"
              (click)="blockedPdf.set(null)"
            >Open the prescription <sd-icon name="external-link" [size]="13" /></a>
          </p>
        }

        @if (loading() && items().length === 0) {
          <div class="flex flex-col gap-3" aria-busy="true">
            <span class="sr-only">Loading prescriptions…</span>
            <div class="sd-shimmer h-24 rounded-card"></div>
            <div class="sd-shimmer h-24 rounded-card"></div>
          </div>
        } @else if (error() && items().length === 0) {
          <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white px-4 py-10 text-center">
            <sd-icon name="wifi-off" [size]="30" class="text-alert" />
            <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
            <sd-button variant="secondary" size="sm" [disabled]="disabled()" (click)="refresh()">
              <sd-icon name="refresh-cw" [size]="16" /> Try again
            </sd-button>
          </div>
        } @else if (items().length === 0) {
          <div class="flex flex-col items-center gap-3 rounded-card border border-dashed border-ash bg-white px-4 py-10 text-center">
            <span class="flex size-14 items-center justify-center rounded-full bg-glacier text-slate">
              <sd-icon name="pill" [size]="26" />
            </span>
            <p class="font-sans text-body-sm text-slate">{{ emptyText() }}</p>
          </div>
        } @else {
          @if (error()) {
            <sd-alert tone="error">{{ error() }}</sd-alert>
          }
          <ul class="flex flex-col gap-3">
            @for (rx of items(); track rx.id) {
              <li class="@container rounded-card border border-cloud bg-white p-4">
                <div
                  class="flex flex-col gap-3"
                  [class]="compact() ? '' : '@xl:flex-row @xl:items-center @xl:justify-between'"
                >
                  <div class="flex min-w-0 flex-col gap-1.5">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="break-all font-sans text-body-sm font-semibold text-ink">{{ rx.number }}</span>
                      <doc-rx-status-badge [status]="rx.status" />
                    </div>
                    <p class="flex flex-wrap gap-x-4 gap-y-1 font-sans text-caption text-slate">
                      <span class="inline-flex items-center gap-1">
                        <sd-icon name="calendar-days" [size]="13" />
                        {{ rx.sent_at ? 'Sent ' + date(rx.sent_at) : 'Created ' + date(rx.created_at) }}
                      </span>
                      @if (rx.valid_until) {
                        <span class="inline-flex items-center gap-1">
                          <sd-icon name="clock" [size]="13" /> Valid until {{ date(rx.valid_until) }}
                        </span>
                      }
                      <span class="inline-flex items-center gap-1">
                        <sd-icon name="pill" [size]="13" /> {{ medicines(rx.items_count) }}
                      </span>
                    </p>
                  </div>

                  <div [class]="compact() ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap gap-2 @xl:justify-end'">
                    @if (rx.status === 'draft') {
                      <button type="button" class="${RX_ACTION}" [disabled]="busy() !== '' || disabled()" (click)="openComposer(rx.id)">
                        <sd-icon name="pen-line" [size]="14" /> Continue
                      </button>
                      <button
                        type="button"
                        class="${RX_ACTION_DANGER}"
                        [disabled]="busy() !== '' || disabled()"
                        [attr.aria-label]="'Delete draft ' + rx.number"
                        (click)="confirmDelete.set(rx)"
                      >
                        <sd-icon name="trash-2" [size]="14" /> {{ busy() === rx.id + ':delete' ? 'Deleting…' : 'Delete draft' }}
                      </button>
                    } @else {
                      <button
                        type="button"
                        class="${RX_ACTION}"
                        [disabled]="busy() !== '' || disabled()"
                        [attr.aria-label]="'View PDF of ' + rx.number"
                        (click)="view(rx)"
                      >
                        <sd-icon name="file-text" [size]="14" /> {{ busy() === rx.id + ':view' ? 'Opening…' : 'View PDF' }}
                      </button>
                      <button
                        type="button"
                        class="${RX_ACTION}"
                        [disabled]="busy() !== '' || disabled()"
                        [attr.aria-label]="'Download ' + rx.number"
                        (click)="download(rx)"
                      >
                        <sd-icon name="download" [size]="14" /> {{ busy() === rx.id + ':download' ? 'Preparing…' : 'Download' }}
                      </button>
                      @if (rx.status === 'active') {
                        <button
                          type="button"
                          class="${RX_ACTION_DANGER}"
                          [class.col-span-2]="compact()"
                          [disabled]="busy() !== '' || disabled()"
                          [attr.aria-label]="'Cancel ' + rx.number"
                          [attr.aria-expanded]="cancelFor() === rx.id"
                          (click)="toggleCancel(rx.id)"
                        >
                          <sd-icon name="circle-x" [size]="14" /> Cancel…
                        </button>
                      }
                    }
                  </div>
                </div>

                @if (cancelFor() === rx.id && !disabled()) {
                  <doc-rx-cancel-form
                    class="mt-3"
                    [prescriptionId]="rx.id"
                    [number]="rx.number"
                    (done)="onCancelled($event)"
                    (dismissed)="cancelFor.set(null)"
                  />
                }
              </li>
            }
          </ul>
        }
      </section>
    }

    <sd-confirm-dialog
      [open]="confirmDelete() !== null"
      title="Delete this draft?"
      [message]="'Draft ' + (confirmDelete()?.number ?? '') + ' will be removed. This cannot be undone.'"
      confirmLabel="Delete draft"
      cancelLabel="Keep it"
      icon="trash-2"
      [danger]="true"
      (confirm)="deleteDraft()"
      (cancel)="confirmDelete.set(null)"
    />

    <sd-confirm-dialog
      [open]="leavePrompt.open()"
      title="Leave without saving?"
      message="Your latest changes to this prescription have not been saved."
      confirmLabel="Leave without saving"
      cancelLabel="Keep editing"
      icon="triangle-alert"
      [danger]="true"
      (confirm)="leavePrompt.answer(true)"
      (cancel)="leavePrompt.answer(false)"
    />
  `,
})
export class RxPanel implements CanLeave {
  private readonly api = inject(DoctorApi);
  private readonly files = inject(RxFiles);
  private readonly destroyRef = inject(DestroyRef);

  readonly patientId = input.required<string>();
  /** The consultation; null lists this doctor's prescriptions for the patient. */
  readonly appointmentId = input<string | null>(null);
  /** Stacked layout for the narrow in-call side panel (~380px). */
  readonly compact = input(false);
  /**
   * Shown during a live video call: a blocked "View PDF" tab never falls back
   * to opening the PDF in this tab (that would end the call) — a link is
   * offered instead.
   */
  readonly inCall = input(false);
  /**
   * Pause everything that talks to the server (e.g. while the portal session
   * is signed out). The list and any half-written prescription stay on screen,
   * so nothing is lost; actions come back once this turns false again.
   */
  readonly disabled = input(false);

  /** Something was saved, sent, cancelled or deleted. */
  readonly changed = output<void>();

  protected readonly items = signal<PrescriptionSummaryDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly actionError = signal('');
  protected readonly notice = signal('');
  protected readonly busy = signal('');
  protected readonly composing = signal(false);
  protected readonly composerId = signal<string | null>(null);
  protected readonly cancelFor = signal<string | null>(null);
  protected readonly confirmDelete = signal<PrescriptionSummaryDto | null>(null);
  /** A PDF whose new tab was blocked during a call — offered as a link. */
  protected readonly blockedPdf = signal<{ number: string; url: string } | null>(null);
  protected readonly leavePrompt = new LeavePrompt();
  protected readonly emptyText = computed(() =>
    this.appointmentId()
      ? 'No prescriptions yet for this consultation'
      : 'No prescriptions yet for this patient',
  );
  private readonly composer = viewChild(RxComposer);
  private sub: Subscription | null = null;

  constructor() {
    effect(() => {
      this.patientId();
      this.appointmentId();
      // Paused (e.g. signed out): reload once actions come back.
      if (this.disabled()) return;
      untracked(() => this.refresh());
    });
    this.destroyRef.onDestroy(() => {
      this.sub?.unsubscribe();
      this.leavePrompt.answer(false);
    });
  }

  /** True while the composer is open with edits that have not been saved. */
  hasUnsavedChanges(): boolean {
    return this.composing() && !!this.composer()?.hasUnsavedChanges();
  }

  /**
   * Ask before the panel is destroyed: resolves true straight away when
   * nothing is unsaved, otherwise shows "Leave without saving?" and resolves
   * with the doctor's answer. The panel must be on screen for the dialog to
   * show — a host that hides the panel should use `hasUnsavedChanges()` with
   * its own dialog instead.
   */
  canLeave(): boolean | Promise<boolean> {
    return this.hasUnsavedChanges() ? this.leavePrompt.ask() : true;
  }

  /** Reload the list (keeps the current rows on screen while loading). */
  refresh(): void {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    const appointmentId = this.appointmentId();
    const req$: Observable<PrescriptionSummaryDto[]> = appointmentId
      ? this.api.listPrescriptions(appointmentId).pipe(map((r) => r.data))
      : this.api
          .allPrescriptions({ patient_id: this.patientId(), per_page: 50 })
          .pipe(map((r) => r.data));
    this.sub = req$.subscribe({
      next: (list) => {
        this.items.set(list);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(apiErrorMessage(err, 'Could not load the prescriptions. Please try again.'));
        this.loading.set(false);
      },
    });
  }

  protected date(value: string | null): string {
    return rxDate(value);
  }

  protected medicines(n: number): string {
    return medicinesLabel(n);
  }

  // ----- composer -----

  protected newPrescription(): void {
    this.openComposer(null);
  }

  protected openComposer(id: string | null): void {
    if (this.disabled()) return;
    this.actionError.set('');
    this.notice.set('');
    this.blockedPdf.set(null);
    this.cancelFor.set(null);
    this.composerId.set(id);
    this.composing.set(true);
  }

  protected closeComposer(): void {
    this.composing.set(false);
    this.composerId.set(null);
    if (!this.disabled()) this.refresh();
  }

  protected onSaved(): void {
    this.refresh();
    this.changed.emit();
  }

  protected onSent(): void {
    this.composing.set(false);
    this.composerId.set(null);
    this.notice.set('Sent — the patient has been notified.');
    this.refresh();
    this.changed.emit();
  }

  // ----- row actions -----

  protected view(rx: PrescriptionSummaryDto): void {
    if (this.busy() || this.disabled()) return;
    this.actionError.set('');
    this.blockedPdf.set(null);
    this.busy.set(`${rx.id}:view`);
    this.files.view(
      rx.id,
      (err) => {
        this.busy.set('');
        this.actionError.set(apiErrorMessage(err, 'Could not open the PDF. Please try again.'));
      },
      () => this.busy.set(''),
      {
        allowSameTab: !this.inCall(),
        onBlocked: (url) => this.blockedPdf.set({ number: rx.number, url }),
      },
    );
  }

  protected download(rx: PrescriptionSummaryDto): void {
    if (this.busy() || this.disabled()) return;
    this.actionError.set('');
    this.busy.set(`${rx.id}:download`);
    this.files.download(
      rx.id,
      (err) => {
        this.busy.set('');
        this.actionError.set(apiErrorMessage(err, 'Could not download the PDF. Please try again.'));
      },
      () => this.busy.set(''),
    );
  }

  protected toggleCancel(id: string): void {
    this.actionError.set('');
    this.notice.set('');
    this.cancelFor.set(this.cancelFor() === id ? null : id);
  }

  protected onCancelled(result: CancelPrescriptionResult): void {
    this.cancelFor.set(null);
    this.changed.emit();
    if (result.replacement) {
      this.openComposer(result.replacement.id);
      return;
    }
    this.notice.set(`${result.cancelled.number} was cancelled.`);
    this.refresh();
  }

  protected deleteDraft(): void {
    const rx = this.confirmDelete();
    this.confirmDelete.set(null);
    if (!rx || this.busy() || this.disabled()) return;
    this.actionError.set('');
    this.notice.set('');
    this.busy.set(`${rx.id}:delete`);
    this.api
      .deletePrescription(rx.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.busy.set('');
          this.notice.set('Draft deleted.');
          this.refresh();
          this.changed.emit();
        },
        error: (err: unknown) => {
          this.busy.set('');
          this.actionError.set(apiErrorMessage(err, 'Could not delete the draft. Please try again.'));
        },
      });
  }
}
