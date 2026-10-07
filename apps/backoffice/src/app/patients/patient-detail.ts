import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  AdminPatientsApi,
  apiErrorMessage,
  openPendingTab,
  PrescriptionsApi,
} from '@supadoc/data-access';
import type {
  AppointmentDto,
  PatientDetailDto,
  PrescriptionStatus,
  PrescriptionSummaryDto,
} from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';

/** Every status reads as icon + words — never colour alone. */
const RX_STATUS: Record<PrescriptionStatus, { label: string; icon: string; cls: string }> = {
  draft: { label: 'Draft', icon: 'pen-line', cls: 'bg-warning/15 text-warning' },
  active: { label: 'Active', icon: 'circle-check', cls: 'bg-sage/15 text-sage' },
  expired: { label: 'Expired', icon: 'hourglass', cls: 'bg-cloud text-slate' },
  cancelled: { label: 'Cancelled', icon: 'circle-x', cls: 'bg-alert/10 text-alert' },
};

/** A single patient record + their recent appointments (route `/patients/:id`). */
@Component({
  selector: 'bo-patient-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, AlertComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <a routerLink="/patients" class="flex w-fit items-center gap-1 font-sans text-body-sm font-semibold text-cerulean hover:underline">
        <sd-icon name="chevron-right" [size]="18" class="rotate-180" /> Back to patients
      </a>

      @if (loading()) {
        <div class="sd-shimmer h-40 rounded-card"></div>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
        </div>
      } @else if (data(); as d) {
        <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
          <div class="flex items-center gap-4">
            <span class="flex size-14 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 font-semibold text-cerulean">{{ initials(d) }}</span>
            <div class="flex flex-col">
              <span class="font-heading text-h5 text-ink">{{ d.patient.first_name }} {{ d.patient.last_name }}</span>
              <span class="font-sans text-body-sm text-slate">{{ d.patient.email }}</span>
            </div>
          </div>
          <dl class="grid grid-cols-1 gap-x-8 gap-y-2 font-sans text-body-sm sm:grid-cols-2">
            <div class="flex justify-between gap-4"><dt class="text-slate">Phone</dt><dd class="text-ink">{{ d.patient.phone || '—' }}{{ d.patient.phone && d.patient.phone_verified ? ' ✓' : '' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Date of birth</dt><dd class="text-ink">{{ d.patient.date_of_birth || '—' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Gender</dt><dd class="capitalize text-ink">{{ d.patient.gender || '—' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">2FA</dt><dd class="text-ink">{{ d.patient.two_factor_enabled ? 'Enabled' : 'Off' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Joined</dt><dd class="text-ink">{{ when(d.patient.created_at) }}</dd></div>
          </dl>
        </section>

        <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
          <h2 class="font-heading text-body-lg text-ink">Appointments ({{ d.appointments_total }})</h2>
          @if (d.appointments.length === 0) {
            <p class="font-sans text-body-sm text-slate">No appointments yet.</p>
          } @else {
            <ul class="flex flex-col divide-y divide-cloud">
              @for (a of d.appointments; track a.id) {
                <li class="flex items-center justify-between gap-3 py-3">
                  <div class="flex flex-col">
                    <a [routerLink]="['/appointments', a.id]" class="font-sans text-body-sm font-medium text-ink hover:text-cerulean">{{ a.specialist.name }}</a>
                    <span class="font-sans text-caption text-slate">{{ when(a.scheduled_at) }} · {{ a.type_label }}</span>
                  </div>
                  <span class="rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold" [class]="statusClass(a.status)">{{ a.status_label }}</span>
                </li>
              }
            </ul>
          }
        </section>

        <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-5 sm:p-6" aria-labelledby="bo-patient-rx-title">
          <div class="flex flex-col gap-1">
            <h2 id="bo-patient-rx-title" class="font-heading text-body-lg text-ink">
              Prescriptions{{ rxLoading() || rxError() ? '' : ' (' + prescriptions().length + ')' }}
            </h2>
            <p class="flex items-start gap-1.5 font-sans text-caption text-slate">
              <sd-icon name="shield-check" [size]="14" class="mt-0.5 shrink-0" />
              Opening a prescription is recorded in the audit log.
            </p>
          </div>

          @if (openError(); as oe) {
            <sd-alert tone="error">{{ oe }}</sd-alert>
          }

          @if (rxLoading()) {
            <div class="flex flex-col gap-2" aria-busy="true" aria-label="Loading prescriptions">
              <div class="sd-shimmer h-16 rounded-field"></div>
              <div class="sd-shimmer h-16 rounded-field"></div>
            </div>
          } @else if (rxError()) {
            <div class="flex flex-col items-center gap-3 py-8 text-center">
              <sd-icon name="wifi-off" [size]="28" class="text-alert" />
              <p class="font-sans text-body-sm text-slate">{{ rxError() }}</p>
              <button
                type="button"
                class="flex items-center gap-2 rounded-field border border-cloud px-4 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean"
                (click)="loadPrescriptions()"
              >
                <sd-icon name="refresh-cw" [size]="16" />Try again
              </button>
            </div>
          } @else if (prescriptions().length === 0) {
            <div class="flex flex-col items-center gap-2 py-8 text-center">
              <span class="flex size-12 items-center justify-center rounded-full bg-glacier text-slate">
                <sd-icon name="pill" [size]="22" />
              </span>
              <p class="font-sans text-body-sm text-slate">No prescriptions have been sent to this patient yet.</p>
            </div>
          } @else {
            <ul class="flex flex-col divide-y divide-cloud">
              @for (rx of prescriptions(); track rx.id) {
                <li class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                  <div class="flex min-w-0 flex-col gap-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="break-all font-sans text-body-sm font-semibold text-ink">{{ rx.number }}</span>
                      <span class="inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold" [class]="rxStatus(rx.status).cls">
                        <sd-icon [name]="rxStatus(rx.status).icon" [size]="14" />{{ rxStatus(rx.status).label }}
                      </span>
                    </div>
                    <dl class="grid grid-cols-1 gap-x-6 gap-y-1 font-sans text-caption sm:grid-cols-3">
                      <div class="flex gap-1.5">
                        <dt class="text-slate">Doctor</dt>
                        <dd class="min-w-0 break-words text-ink">{{ rx.prescriber || '—' }}</dd>
                      </div>
                      <div class="flex gap-1.5">
                        <dt class="text-slate">Sent</dt>
                        <dd class="text-ink">{{ dateOnly(rx.sent_at) }}</dd>
                      </div>
                      <div class="flex gap-1.5">
                        <dt class="text-slate">Valid until</dt>
                        <dd class="text-ink">{{ calendarDay(rx.valid_until) }}</dd>
                      </div>
                    </dl>
                  </div>
                  <button
                    type="button"
                    class="flex shrink-0 items-center justify-center gap-2 rounded-field border border-cloud px-4 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60"
                    [disabled]="opening() === rx.id"
                    [attr.aria-label]="'View PDF of prescription ' + rx.number"
                    (click)="viewPdf(rx)"
                  >
                    @if (opening() === rx.id) {
                      <sd-icon name="loader-circle" [size]="16" class="animate-spin" />Opening…
                    } @else {
                      <sd-icon name="file-text" [size]="16" />View PDF
                    }
                  </button>
                </li>
              }
            </ul>
          }
        </section>
      }
    </div>
  `,
})
export class AdminPatientDetail implements OnInit {
  private readonly api = inject(AdminPatientsApi);
  private readonly rxApi = inject(PrescriptionsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly data = signal<PatientDetailDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');

  /** The patient's sent prescriptions (summary rows — never medicine names). */
  protected readonly prescriptions = signal<PrescriptionSummaryDto[]>([]);
  protected readonly rxLoading = signal(true);
  protected readonly rxError = signal('');
  /** Id of the prescription whose PDF link is being fetched. */
  protected readonly opening = signal<string | null>(null);
  protected readonly openError = signal('');

  private patientId = '';

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.patientId = id;
    this.loadPrescriptions();
    this.api
      .get(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.error.set(apiErrorMessage(err, 'Could not load this patient.'));
          this.loading.set(false);
        },
      });
  }

  protected loadPrescriptions(): void {
    this.rxLoading.set(true);
    this.rxError.set('');
    this.rxApi
      .forPatient(this.patientId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.prescriptions.set(res.data ?? []);
          this.rxLoading.set(false);
        },
        error: (err: unknown) => {
          this.rxError.set(apiErrorMessage(err, "Could not load this patient's prescriptions."));
          this.rxLoading.set(false);
        },
      });
  }

  /**
   * Open the prescription PDF in a new tab. The placeholder tab is opened
   * synchronously (inside the click) so popup blockers allow it; the signed,
   * short-lived link is fetched afterwards. The server records the open in the
   * audit log.
   */
  protected viewPdf(rx: PrescriptionSummaryDto): void {
    if (this.opening() === rx.id) return;
    const pending = openPendingTab();
    this.opening.set(rx.id);
    this.openError.set('');
    // Not tied to the component's lifetime: if the admin navigates away the
    // placeholder tab must still receive its URL (or be closed).
    this.rxApi.staffLink(rx.id, false).subscribe({
      next: (res) => {
        pending.go(this.rxApi.fileUrl(res.data));
        this.opening.set(null);
      },
      error: (err: unknown) => {
        pending.fail();
        this.openError.set(
          `${rx.number}: ${apiErrorMessage(err, 'Could not open this prescription. Please try again.')}`,
        );
        this.opening.set(null);
      },
    });
  }

  protected rxStatus(status: PrescriptionStatus): { label: string; icon: string; cls: string } {
    return RX_STATUS[status] ?? { label: status, icon: 'info', cls: 'bg-cloud text-slate' };
  }

  /** A date-time shown as a day, e.g. "7 Oct 2026". */
  protected dateOnly(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? '—'
      : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }

  /** A `YYYY-MM-DD` calendar day, formatted without any time-zone shift. */
  protected calendarDay(ymd: string | null): string {
    const m = ymd ? /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd) : null;
    if (!m) return '—';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }

  protected initials(d: PatientDetailDto): string {
    return `${d.patient.first_name?.[0] ?? ''}${d.patient.last_name?.[0] ?? ''}`.toUpperCase() || '?';
  }

  protected statusClass(status: AppointmentDto['status']): string {
    switch (status) {
      case 'confirmed':
      case 'completed':
        return 'bg-sage/15 text-sage';
      case 'cancelled':
        return 'bg-alert/10 text-alert';
      case 'rescheduled':
        return 'bg-cloud text-slate';
      default:
        return 'bg-warning/15 text-warning';
    }
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? '—'
      : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
  }
}
