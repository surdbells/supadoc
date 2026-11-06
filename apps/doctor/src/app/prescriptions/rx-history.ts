import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, DoctorApi, doctorStandingCode } from '@supadoc/data-access';
import type { PrescriptionSummaryDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import type { Subscription } from 'rxjs';
import { standingText } from '../call-workspace/call-workspace-copy';
import { DoctorClock } from '../doctor-clock';
import { RxFiles } from './rx-files';
import { medicinesLabel, RX_ACTION, rxDate, RxStatusBadge } from './rx-shared';

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40';

/**
 * This doctor's prescriptions for a patient (any consultation), read-only: the
 * call's Full EMR. One action: View PDF, for sent prescriptions only (a draft's
 * PDF is Print-only, and `prescriptionSource` would offer Download). No New,
 * Continue, Delete, Cancel or Download.
 */
@Component({
  selector: 'doc-rx-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, RxStatusBadge],
  host: { class: 'block' },
  template: `
    @if (loading() && items().length === 0) {
      <div class="flex flex-col gap-3" aria-busy="true">
        <span class="sr-only" role="status">Loading the prescriptions…</span>
        <div class="sd-shimmer h-24 rounded-card"></div>
        <div class="sd-shimmer h-24 rounded-card"></div>
      </div>
    } @else if (error()) {
      <div class="flex flex-col items-center gap-3 rounded-card border border-haze bg-white px-4 py-10 text-center shadow-card">
        <sd-icon name="circle-alert" [size]="28" class="text-alert" />
        <p class="font-sans text-body-sm text-slate" role="alert">{{ error() }}</p>
        @if (!standing()) {
          <button type="button" class="${RX_ACTION} min-h-11 ${FOCUS_RING}" (click)="load()">
            <sd-icon name="refresh-cw" [size]="14" /> Try again
          </button>
        }
      </div>
    } @else if (items().length === 0) {
      <div class="flex flex-col items-center gap-3 rounded-card border border-dashed border-ash bg-white px-4 py-10 text-center">
        <span class="flex size-14 items-center justify-center rounded-full bg-glacier text-slate">
          <sd-icon name="pill" [size]="26" />
        </span>
        <p class="font-sans text-body-sm text-slate">You haven't written a prescription for this patient yet.</p>
      </div>
    } @else {
      <ul class="flex flex-col gap-3">
        @for (rx of items(); track rx.id) {
          <li class="flex flex-col gap-3 rounded-card border border-haze bg-white p-4 shadow-card sm:flex-row sm:items-center sm:justify-between">
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
            @if (rx.status !== 'draft') {
              <button
                type="button"
                class="${RX_ACTION} min-h-11 shrink-0 ${FOCUS_RING}"
                [attr.aria-label]="'View PDF of ' + rx.number"
                (click)="view(rx, $event.currentTarget)"
              >
                <sd-icon name="file-text" [size]="14" /> View PDF
              </button>
            }
          </li>
        }
      </ul>
      @if (total() > 50) {
        <p class="mt-3 font-sans text-caption text-slate">Showing the 50 most recent.</p>
      }
    }
  `,
})
export class RxHistory {
  /** The doctor's clock (their profile time zone): every time shown here. */
  private readonly clock = inject(DoctorClock);
  private readonly api = inject(DoctorApi);
  private readonly files = inject(RxFiles);
  private readonly destroyRef = inject(DestroyRef);

  readonly patientId = input.required<string>();
  /**
   * On screen. The host keeps this list mounted, so it reads again each time it
   * comes back: what was sent or cancelled meanwhile (the call's Prescriptions tab) shows.
   */
  readonly active = input(true);

  protected readonly items = signal<PrescriptionSummaryDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  /** The API refused the doctor for their standing: Try again cannot help. */
  protected readonly standing = signal(false);
  protected readonly total = signal(0);
  private sub: Subscription | null = null;
  private listedFor: string | null = null;

  constructor() {
    effect(() => {
      const id = this.patientId();
      const active = this.active();
      untracked(() => {
        if (id !== this.listedFor) this.forget(id);
        if (active) this.load();
      });
    });
  }

  /** Another patient: nothing of the last one stays, on screen or on its way. */
  private forget(id: string): void {
    this.listedFor = id;
    this.sub?.unsubscribe();
    this.items.set([]);
    this.total.set(0);
    this.error.set('');
    this.standing.set(false);
    this.loading.set(true);
  }

  /** Try again, and the host's Refresh. The list stays on screen until the answer. */
  load(): void {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    this.standing.set(false);
    this.sub = this.api
      .allPrescriptions({ patient_id: this.patientId(), per_page: 50 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.set(res.data);
          this.total.set(res.meta?.total ?? res.data.length);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          const code = doctorStandingCode(err);
          this.standing.set(!!code);
          this.error.set(code ? standingText(code, apiErrorMessage(err, '')) : 'Could not load the prescriptions.');
          this.loading.set(false);
        },
      });
  }

  protected date(value: string | null): string {
    return rxDate(value, this.clock.zone());
  }

  protected medicines(n: number): string {
    return medicinesLabel(n);
  }

  protected view(rx: PrescriptionSummaryDto, opener: EventTarget | null): void {
    this.files.view(rx, opener instanceof HTMLElement ? opener : null);
  }
}
