import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { CreateLabRequestInput } from '@supadoc/models';
import { AlertComponent, DialogComponent, IconComponent } from '@supadoc/ui';
import { SignaturePad } from '../prescriptions/signature-pad';
import { LabRequestSummary, type LabSummaryView } from './lab-request-summary';
import { drName } from './lab-ui';

/**
 * "Preview request": the request as the patient and the lab will get it, the
 * signature (the saved one, or a pad when there is none) and the attestation.
 * "Send to Patient" stays pale (`aria-disabled`) until the attestation is
 * ticked — and, when signing by hand, the pad holds a signature; clicking it
 * then focuses what is missing.
 */
@Component({
  selector: 'doc-lab-preview-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, DialogComponent, IconComponent, LabRequestSummary, SignaturePad],
  styles: `
    .pv-btn {
      min-width: 154px;
      height: 48px;
    }
    .pv-check {
      width: 18px;
      height: 18px;
      accent-color: var(--color-cerulean);
    }
  `,
  template: `
    <sd-dialog
      [open]="open()"
      [maxWidth]="769"
      title="Preview request"
      [busy]="busy()"
      (closed)="closed.emit()"
    >
      <div class="flex flex-col gap-6">
        @if (notice()) {
          <sd-alert tone="info">{{ notice() }}</sd-alert>
        }
        @if (view(); as v) {
          <doc-lab-request-summary [view]="v" />
        }

        @if (!hasSignature()) {
          <div #padWrap tabindex="-1" class="flex flex-col gap-2 border-t border-haze pt-4 outline-none">
            <p class="font-sans text-body-sm font-semibold text-ink">Sign to send</p>
            <p id="lab-sign-help" class="font-sans text-caption text-slate">You haven't saved a signature yet. Sign in the box.</p>
            <doc-signature-pad [height]="150" (changed)="drawn.set($event)" />
            <label class="flex cursor-pointer items-center gap-2 font-sans text-body-sm text-ink">
              <input type="checkbox" class="pv-check" [checked]="saveSignature()" (change)="saveSignature.set($any($event.target).checked)" />
              Also save this as my signature
            </label>
          </div>
        }

        <div class="flex flex-col gap-4 border-t border-haze pt-4">
          <div class="flex items-start gap-2">
            <input
              #attestBox
              id="lab-attest"
              type="checkbox"
              class="pv-check mt-0.5 shrink-0"
              [checked]="attested()"
              (change)="attested.set($any($event.target).checked)"
            />
            <label for="lab-attest" class="cursor-pointer font-sans text-body-sm">
              <span [class]="attested() ? 'text-ink' : 'text-alert-ink'">I confirm these tests are clinically indicated.</span>
              <span class="font-semibold text-ink"> {{ signer() }}, e-signed</span>
            </label>
          </div>

          @if (error()) {
            <p role="alert" class="rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-alert-ink">{{ error() }}</p>
          }
          @if (disabled()) {
            <p class="flex items-start gap-2 rounded-field bg-warning/10 px-3 py-2.5 font-sans text-body-sm text-ink" role="status">
              <sd-icon name="lock" [size]="16" class="mt-0.5 shrink-0 text-warning" /> You are signed out. Sign in again to send — your selections are kept here.
            </p>
          }

          <div class="flex flex-col-reverse items-center justify-center gap-4 sm:flex-row">
            <button
              type="button"
              class="pv-btn rounded-field border border-cerulean bg-white px-4 font-sans text-body-sm font-medium text-cerulean-dark transition-colors hover:bg-glacier focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
              [disabled]="busy()"
              (click)="closed.emit()"
            >
              Back to request
            </button>
            <button
              type="button"
              class="pv-btn rounded-field px-4 font-sans text-body-sm font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
              [class]="ready() && !busy() && !disabled() ? 'bg-cerulean hover:bg-cerulean-dark' : 'bg-cerulean/40'"
              [disabled]="busy() || disabled()"
              [attr.aria-disabled]="!ready() || null"
              (click)="trySend()"
            >
              {{ busy() ? 'Sending…' : 'Send to Patient' }}
            </button>
          </div>
        </div>
      </div>
    </sd-dialog>
  `,
})
export class LabPreviewDialog {
  readonly open = input(false);
  /** Bumped by the host on every open: each Preview is attested afresh. */
  readonly session = input(0);
  readonly view = input<LabSummaryView | null>(null);
  readonly hasSignature = input(true);
  /** The signed-in doctor's name (the clock's profile). */
  readonly doctorName = input<string | null>(null);
  readonly busy = input(false);
  readonly error = input<string | null>(null);
  /** A message at the top (e.g. the test list was updated). */
  readonly notice = input<string | null>(null);
  /** Signed out (the call keeps the form): Send to Patient does nothing, and says why. */
  readonly disabled = input(false);

  readonly send = output<CreateLabRequestInput['signature']>();
  readonly closed = output<void>();

  protected readonly attested = signal(false);
  protected readonly drawn = signal<string | null>(null);
  protected readonly saveSignature = signal(true);

  private readonly attestBox = viewChild<ElementRef<HTMLInputElement>>('attestBox');
  private readonly padWrap = viewChild<ElementRef<HTMLElement>>('padWrap');

  protected readonly signer = computed(() => drName(this.doctorName()));
  protected readonly ready = computed(() => this.attested() && (this.hasSignature() || !!this.drawn()));

  constructor() {
    // Each Preview is attested afresh.
    effect(() => {
      this.session();
      if (this.open()) {
        untracked(() => {
          this.attested.set(false);
          this.drawn.set(null);
          this.saveSignature.set(true);
        });
      }
    });
  }

  protected trySend(): void {
    if (this.busy() || this.disabled()) return;
    if (!this.attested()) {
      this.attestBox()?.nativeElement.focus();
      return;
    }
    if (!this.hasSignature() && !this.drawn()) {
      const pad = this.padWrap()?.nativeElement;
      pad?.scrollIntoView?.({ block: 'center' });
      pad?.focus();
      return;
    }
    const image = this.drawn();
    this.send.emit(this.hasSignature() || !image ? { mode: 'saved' } : { mode: 'drawn', image, save: this.saveSignature() });
  }
}
