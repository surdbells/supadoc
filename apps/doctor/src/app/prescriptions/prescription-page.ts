import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type {
  CancelPrescriptionResult,
  PrescriptionDto,
  PrescriptionOptionsDto,
  ReadingKey,
} from '@supadoc/models';
import { AlertComponent, ConfirmDialogComponent, IconComponent } from '@supadoc/ui';
import { catchError, forkJoin, map, of, Subscription } from 'rxjs';
import { RxCancelForm } from './rx-cancel-form';
import { RxComposer } from './rx-composer';
import { RxFiles } from './rx-files';
import {
  RX_ACTION,
  RX_ACTION_DANGER,
  RX_FOLLOW_UP_LABELS,
  RX_PREGNANCY_LABELS,
  RX_READING_LABELS,
  RX_SOURCE_LABELS,
  rxDate,
  rxDateTime,
  RxStatusBadge,
  withUnit,
} from './rx-shared';
import { CanLeave, LeavePrompt } from './unsaved-changes.guard';

interface ReadingLine {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

const READING_ORDER: ReadingKey[] = [
  'temperature',
  'heart_rate',
  'blood_pressure',
  'respiratory_rate',
  'oxygen_saturation',
  'blood_sugar',
  'weight',
  'height',
  'bmi',
  'pain_score',
];

const CARD = 'flex flex-col gap-4 rounded-card border border-cloud bg-white p-4 sm:p-6';
const H2 = 'flex items-center gap-2 font-heading text-body-lg text-ink';
const DT = 'font-sans text-caption text-slate';
const DD = 'font-sans text-body-sm text-ink break-words';

/**
 * One prescription (route `/prescriptions/:id`). A draft opens in the composer;
 * anything sent is shown read-only with View PDF / Download / Cancel….
 */
@Component({
  selector: 'doc-prescription-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    AlertComponent,
    ConfirmDialogComponent,
    IconComponent,
    RxCancelForm,
    RxComposer,
    RxStatusBadge,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <a routerLink="/prescriptions" class="flex w-fit items-center gap-1 font-sans text-body-sm text-slate transition-colors hover:text-cerulean">
        <sd-icon name="chevron-right" [size]="16" class="rotate-180" /> Prescriptions
      </a>

      @if (loading()) {
        <div class="flex flex-col gap-4" aria-busy="true">
          <span class="sr-only">Loading the prescription…</span>
          <div class="sd-shimmer h-28 rounded-card"></div>
          <div class="sd-shimmer h-48 rounded-card"></div>
        </div>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white px-4 py-16 text-center">
          <sd-icon name="circle-alert" [size]="32" class="text-alert" />
          <p class="max-w-sm font-sans text-body-sm text-slate">{{ error() }}</p>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-field border border-cloud px-4 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean"
            (click)="load(currentId)"
          >
            <sd-icon name="refresh-cw" [size]="16" /> Try again
          </button>
        </div>
      } @else if (rx(); as r) {
        @if (r.status === 'draft') {
          <header class="flex flex-col gap-1">
            <h1 class="font-heading text-h3 text-ink">Draft prescription</h1>
            <p class="font-sans text-body text-slate">
              {{ r.patient_name ? 'For ' + r.patient_name + '. ' : '' }}Finish it, then send it to the patient.
            </p>
          </header>
          <doc-rx-composer
            [patientId]="r.patient_id"
            [appointmentId]="r.appointment_id"
            [prescriptionId]="r.id"
            (sent)="load(r.id)"
            (closed)="onClosed()"
          />
        } @else {
          <!-- Summary header -->
          <section class="${CARD}">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div class="flex min-w-0 flex-col gap-1">
                <span class="${DT}">Prescription</span>
                <h1 class="break-all font-heading text-h4 text-ink">{{ r.number }}</h1>
                <p class="font-sans text-body-sm text-slate">
                  {{ patientName(r) }}{{ r.sent_at ? ' · Sent ' + dateTime(r.sent_at) : '' }}
                </p>
              </div>
              <doc-rx-status-badge [status]="r.status" />
            </div>

            <dl class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div class="flex flex-col gap-0.5">
                <dt class="${DT}">Valid until</dt>
                <dd class="${DD}">{{ date(r.valid_until) }}</dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="${DT}">Repeats allowed</dt>
                <dd class="${DD}">{{ r.allows_repeats ? 'Yes' : 'No' }}</dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="${DT}">Pages</dt>
                <dd class="${DD}">{{ r.page_count === 2 ? '2 (medicines 6–' + r.items.length + ' on page 2)' : '1' }}</dd>
              </div>
            </dl>

            @if (r.status === 'cancelled') {
              <div class="flex flex-col gap-1 rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-ink" role="note">
                <span class="flex items-center gap-2 font-semibold text-alert">
                  <sd-icon name="circle-x" [size]="16" /> Cancelled{{ r.cancelled_at ? ' on ' + dateTime(r.cancelled_at) : '' }}
                </span>
                @if (r.cancel_reason) {
                  <span>Reason: {{ r.cancel_reason }}</span>
                }
                @if (r.replaced_by_id) {
                  <a [routerLink]="['/prescriptions', r.replaced_by_id]" class="inline-flex w-fit items-center gap-1 font-semibold text-cerulean hover:underline">
                    View the replacement <sd-icon name="arrow-right" [size]="14" />
                  </a>
                }
              </div>
            }
            @if (r.status === 'expired') {
              <div class="flex items-center gap-2 rounded-field bg-cloud px-4 py-3 font-sans text-body-sm text-ink" role="note">
                <sd-icon name="hourglass" [size]="16" class="text-slate" /> This prescription expired after {{ date(r.valid_until) }}.
              </div>
            }
            @if (r.replaces_id) {
              <p class="font-sans text-caption text-slate">
                This replaces an earlier prescription.
                <a [routerLink]="['/prescriptions', r.replaces_id]" class="font-semibold text-cerulean hover:underline">View it</a>
              </p>
            }

            @if (actionError()) {
              <sd-alert tone="error">{{ actionError() }}</sd-alert>
            } @else if (notice()) {
              <sd-alert tone="success">{{ notice() }}</sd-alert>
            }

            <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              <button type="button" class="${RX_ACTION}" [disabled]="busy() !== ''" (click)="view(r)">
                <sd-icon name="file-text" [size]="14" /> {{ busy() === 'view' ? 'Opening…' : 'View PDF' }}
              </button>
              <button type="button" class="${RX_ACTION}" [disabled]="busy() !== ''" (click)="download(r)">
                <sd-icon name="download" [size]="14" /> {{ busy() === 'download' ? 'Preparing…' : 'Download' }}
              </button>
              @if (r.status === 'active') {
                <button
                  type="button"
                  class="${RX_ACTION_DANGER} col-span-2"
                  [disabled]="busy() !== ''"
                  [attr.aria-expanded]="cancelling()"
                  (click)="cancelling.set(!cancelling())"
                >
                  <sd-icon name="circle-x" [size]="14" /> Cancel…
                </button>
              }
            </div>

            @if (cancelling() && r.status === 'active') {
              <doc-rx-cancel-form
                [prescriptionId]="r.id"
                [number]="r.number"
                (done)="onCancelled($event)"
                (dismissed)="cancelling.set(false)"
              />
            }
          </section>

          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <!-- Patient -->
            <section class="${CARD}">
              <h2 class="${H2}"><sd-icon name="user" [size]="18" class="text-cerulean" /> Patient</h2>
              <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="flex flex-col gap-0.5"><dt class="${DT}">Name</dt><dd class="${DD}">{{ patientName(r) }}</dd></div>
                <div class="flex flex-col gap-0.5"><dt class="${DT}">Date of birth</dt><dd class="${DD}">{{ r.patient_details.date_of_birth || '—' }}</dd></div>
                <div class="flex flex-col gap-0.5"><dt class="${DT}">Sex</dt><dd class="${DD}">{{ r.patient_details.sex || '—' }}</dd></div>
                <div class="flex flex-col gap-0.5"><dt class="${DT}">Age</dt><dd class="${DD}">{{ r.patient_details.age || '—' }}</dd></div>
                @if (r.patient_details.reference) {
                  <div class="flex flex-col gap-0.5"><dt class="${DT}">Patient reference</dt><dd class="${DD}">{{ r.patient_details.reference }}</dd></div>
                }
              </dl>
            </section>

            <!-- Prescriber -->
            <section class="${CARD}">
              <h2 class="${H2}"><sd-icon name="stethoscope" [size]="18" class="text-cerulean" /> Prescriber</h2>
              <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="flex flex-col gap-0.5"><dt class="${DT}">Doctor</dt><dd class="${DD}">{{ r.prescriber_details.name || r.prescriber || '—' }}</dd></div>
                <div class="flex flex-col gap-0.5"><dt class="${DT}">Specialty</dt><dd class="${DD}">{{ r.prescriber_details.specialty || '—' }}</dd></div>
                <div class="flex flex-col gap-0.5"><dt class="${DT}">Qualifications</dt><dd class="${DD}">{{ r.prescriber_details.qualifications || '—' }}</dd></div>
                <div class="flex flex-col gap-0.5"><dt class="${DT}">MDCN number</dt><dd class="${DD}">{{ r.prescriber_details.mdcn_number || '—' }}</dd></div>
                <div class="flex flex-col gap-0.5">
                  <dt class="${DT}">Signed</dt>
                  <dd class="${DD}">
                    {{ dateTime(r.signed_at || r.sent_at) }}{{ r.signature_mode ? (r.signature_mode === 'saved' ? ' · saved signature' : ' · signed by hand') : '' }}
                  </dd>
                </div>
              </dl>
            </section>
          </div>

          <!-- Readings -->
          <section class="${CARD}">
            <h2 class="${H2}"><sd-icon name="heart-pulse" [size]="18" class="text-cerulean" /> Health readings</h2>
            @if (readingLines().length === 0) {
              <p class="font-sans text-body-sm text-slate">No readings were recorded.</p>
            } @else {
              <dl class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                @for (l of readingLines(); track l.key) {
                  <div class="flex flex-col gap-0.5 rounded-field bg-glacier px-3 py-2">
                    <dt class="${DT}">{{ l.label }}</dt>
                    <dd class="${DD} font-semibold">{{ l.value }}</dd>
                  </div>
                }
              </dl>
              <p class="font-sans text-caption text-slate">
                {{ readingsSource(r) }}{{ r.readings.taken_at ? ' · Taken ' + dateTime(r.readings.taken_at) : '' }}
              </p>
            }
          </section>

          <!-- Consultation -->
          <section class="${CARD}">
            <h2 class="${H2}"><sd-icon name="clipboard-list" [size]="18" class="text-cerulean" /> Consultation</h2>
            <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div class="flex flex-col gap-0.5 sm:col-span-2"><dt class="${DT}">Reason for the prescription</dt><dd class="${DD} whitespace-pre-line">{{ r.reason || '—' }}</dd></div>
              <div class="flex flex-col gap-0.5"><dt class="${DT}">Illness code (ICD)</dt><dd class="${DD}">{{ r.icd_code || '—' }}</dd></div>
              <div class="flex flex-col gap-0.5"><dt class="${DT}">Pregnant or breastfeeding?</dt><dd class="${DD}">{{ pregnancyLabel(r) }}</dd></div>
              <div class="flex flex-col gap-0.5 sm:col-span-2"><dt class="${DT}">Medicines already taken</dt><dd class="${DD}">{{ r.current_medications || '—' }}</dd></div>
            </dl>
          </section>

          <!-- Medicines -->
          <section class="${CARD}">
            <h2 class="${H2}"><sd-icon name="pill" [size]="18" class="text-cerulean" /> Medicines</h2>
            <ol class="flex flex-col gap-3">
              @for (it of r.items; track $index; let i = $index) {
                @if (i === 5) {
                  <li class="flex items-center gap-3" role="separator" aria-label="Page 2 of 2">
                    <span class="h-px flex-1 bg-ash"></span>
                    <span class="font-sans text-caption font-semibold text-slate">Page 2 of 2</span>
                    <span class="h-px flex-1 bg-ash"></span>
                  </li>
                }
                <li class="flex flex-col gap-3 rounded-field border border-cloud p-4">
                  <div class="flex items-start gap-3">
                    <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-cerulean font-sans text-caption font-semibold text-white" aria-hidden="true">{{ i + 1 }}</span>
                    <div class="flex min-w-0 flex-col gap-1">
                      <span class="break-words font-sans text-body-sm font-semibold text-ink">{{ it.name || 'Medicine not chosen' }}</span>
                      <span class="flex flex-wrap items-center gap-1.5 font-sans text-caption text-slate">
                        @if (it.branded) {
                          <span class="rounded-pill bg-warning/20 px-2 py-0.5 font-semibold text-ink">Brand</span>
                        }
                        @if (it.dose_form) { <span>{{ it.dose_form }}</span> }
                        @if (it.branded && it.generic_name) { <span>· {{ it.generic_name }}</span> }
                        @if (it.no_substitute) {
                          <span class="inline-flex items-center gap-1 rounded-pill bg-alert/10 px-2 py-0.5 font-semibold text-alert">
                            <sd-icon name="lock" [size]="11" /> No substitute
                          </span>
                        }
                      </span>
                    </div>
                  </div>
                  <dl class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    <div class="flex flex-col gap-0.5"><dt class="${DT}">How much</dt><dd class="${DD}">{{ it.dose || '—' }}</dd></div>
                    <div class="flex flex-col gap-0.5"><dt class="${DT}">How to take it</dt><dd class="${DD}">{{ it.route || '—' }}</dd></div>
                    <div class="flex flex-col gap-0.5"><dt class="${DT}">How often</dt><dd class="${DD}">{{ it.frequency || '—' }}</dd></div>
                    <div class="flex flex-col gap-0.5"><dt class="${DT}">For how long</dt><dd class="${DD}">{{ it.duration || '—' }}</dd></div>
                    <div class="flex flex-col gap-0.5"><dt class="${DT}">Quantity</dt><dd class="${DD}">{{ it.quantity || '—' }}</dd></div>
                    <div class="flex flex-col gap-0.5"><dt class="${DT}">Repeats</dt><dd class="${DD}">{{ it.repeats }}</dd></div>
                  </dl>
                  @if (it.instructions) {
                    <p class="rounded-field bg-glacier px-3 py-2 font-sans text-body-sm text-ink">{{ it.instructions }}</p>
                  }
                </li>
              } @empty {
                <li class="font-sans text-body-sm text-slate">No medicines.</li>
              }
            </ol>
          </section>

          <!-- Advice + follow-up -->
          <section class="${CARD}">
            <h2 class="${H2}"><sd-icon name="calendar-days" [size]="18" class="text-cerulean" /> Advice and follow-up</h2>
            <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div class="flex flex-col gap-0.5 sm:col-span-2"><dt class="${DT}">Advice to the patient</dt><dd class="${DD} whitespace-pre-line">{{ r.advice || '—' }}</dd></div>
              <div class="flex flex-col gap-0.5">
                <dt class="${DT}">Follow-up</dt>
                <dd class="${DD}">{{ r.follow_up_date ? date(r.follow_up_date) + (r.follow_up_mode ? ' · ' + followUpLabel(r) : '') : '—' }}</dd>
              </div>
              <div class="flex flex-col gap-0.5"><dt class="${DT}">Tests or referrals</dt><dd class="${DD}">{{ r.tests_referrals || '—' }}</dd></div>
            </dl>
          </section>
        }
      }
    </div>

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
export class PrescriptionPage implements CanLeave {
  private readonly api = inject(DoctorApi);
  private readonly auth = inject(StaffAuthService);
  private readonly files = inject(RxFiles);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly composer = viewChild(RxComposer);
  protected readonly leavePrompt = new LeavePrompt();
  /** The doctor already confirmed in the composer: skip the leave prompt. */
  private leaving = false;

  protected readonly rx = signal<PrescriptionDto | null>(null);
  protected readonly options = signal<PrescriptionOptionsDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly actionError = signal('');
  protected readonly notice = signal('');
  protected readonly busy = signal<'' | 'view' | 'download'>('');
  protected readonly cancelling = signal(false);
  protected currentId = '';
  private sub: Subscription | null = null;

  protected readonly readingLines = computed<ReadingLine[]>(() => {
    const r = this.rx();
    if (!r) return [];
    const fields = this.options()?.readings;
    const lines: ReadingLine[] = [];
    for (const key of READING_ORDER) {
      const value = r.readings?.[key];
      if (value === undefined || value === null || String(value) === '') continue;
      const f = fields?.find((x) => x.key === key);
      const label = f?.label ?? RX_READING_LABELS[key].label;
      const unit = f?.unit ?? RX_READING_LABELS[key].unit;
      lines.push({ key, label, value: withUnit(String(value), unit) });
    }
    return lines;
  });

  constructor() {
    // The same component instance is reused for /prescriptions/A → /prescriptions/B.
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((p) => {
      this.leaving = false;
      this.load(p.get('id') ?? '');
    });
    this.destroyRef.onDestroy(() => {
      this.sub?.unsubscribe();
      this.leavePrompt.answer(false);
    });
  }

  /** Route guard hook: ask before a navigation throws away an unsaved draft. */
  canLeave(): boolean | Promise<boolean> {
    // A sign-out (idle timeout, session expiry, signed out elsewhere) must
    // still clear the screen — never hold patient details up behind a prompt.
    if (this.leaving || !this.auth.isAuthenticated()) return true;
    return this.composer()?.hasUnsavedChanges() ? this.leavePrompt.ask() : true;
  }

  protected load(id: string): void {
    this.sub?.unsubscribe();
    this.currentId = id;
    this.loading.set(true);
    this.error.set('');
    this.actionError.set('');
    this.cancelling.set(false);
    const known = this.options();
    // The option lists only supply labels here, so a failure there is not fatal.
    const options$ = known
      ? of(known)
      : this.api.prescriptionOptions().pipe(
          map((r) => r.data as PrescriptionOptionsDto | null),
          catchError(() => of(null)),
        );
    this.sub = forkJoin([this.api.getPrescription(id).pipe(map((r) => r.data)), options$]).subscribe({
      next: ([rx, opts]) => {
        this.rx.set(rx);
        if (opts) this.options.set(opts);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.rx.set(null);
        this.error.set(apiErrorMessage(err, 'Could not load this prescription.'));
        this.loading.set(false);
      },
    });
  }

  /** The composer's Close — it already asked "Close without saving?" if needed. */
  protected onClosed(): void {
    this.leaving = true;
    void this.router.navigate(['/prescriptions']).then(
      (ok) => {
        if (!ok) this.leaving = false;
      },
      () => {
        this.leaving = false;
      },
    );
  }

  protected view(r: PrescriptionDto): void {
    if (this.busy()) return;
    this.actionError.set('');
    this.busy.set('view');
    this.files.view(
      r.id,
      (err) => {
        this.busy.set('');
        this.actionError.set(apiErrorMessage(err, 'Could not open the PDF. Please try again.'));
      },
      () => this.busy.set(''),
    );
  }

  protected download(r: PrescriptionDto): void {
    if (this.busy()) return;
    this.actionError.set('');
    this.busy.set('download');
    this.files.download(
      r.id,
      (err) => {
        this.busy.set('');
        this.actionError.set(apiErrorMessage(err, 'Could not download the PDF. Please try again.'));
      },
      () => this.busy.set(''),
    );
  }

  protected onCancelled(result: CancelPrescriptionResult): void {
    this.cancelling.set(false);
    if (result.replacement) {
      void this.router.navigate(['/prescriptions', result.replacement.id]);
      return;
    }
    this.rx.set(result.cancelled);
    this.notice.set(`${result.cancelled.number} was cancelled. The patient has been told.`);
  }

  // ----- display helpers -----

  protected date(value: string | null): string {
    return rxDate(value);
  }

  protected dateTime(value: string | null | undefined): string {
    return rxDateTime(value);
  }

  protected patientName(r: PrescriptionDto): string {
    return r.patient_details?.name || r.patient_name || 'Patient';
  }

  protected pregnancyLabel(r: PrescriptionDto): string {
    const s = r.pregnancy_status;
    if (!s) return '—';
    return this.options()?.pregnancy[s] ?? RX_PREGNANCY_LABELS[s] ?? s;
  }

  protected followUpLabel(r: PrescriptionDto): string {
    const m = r.follow_up_mode;
    if (!m) return '';
    return this.options()?.follow_up_modes[m] ?? RX_FOLLOW_UP_LABELS[m] ?? m;
  }

  protected readingsSource(r: PrescriptionDto): string {
    const s = r.readings?.source;
    if (!s) return 'Source not stated';
    return `From: ${this.options()?.reading_sources[s] ?? RX_SOURCE_LABELS[s] ?? s}`;
  }
}
