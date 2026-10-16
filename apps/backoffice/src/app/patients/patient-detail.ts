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
import { AlertComponent, EmptyStateComponent, IconComponent } from '@supadoc/ui';
import { appointmentBadge, AppointmentBadge, ATTENTION_BADGE } from '../shared/appointment-status';
import {
  AVATAR_SM,
  BACK_LINK,
  BTN_SECONDARY,
  CHIP,
  COUNT_PILL,
  DETAIL_AVATAR,
  DETAIL_HEADER,
  DETAIL_NAME,
  EMPTY_FRAME,
  INFO_TILE,
  INFO_TILE_LABEL,
  INFO_TILE_VALUE,
  INFO_TILES,
  LIST_CARD_EMPTY,
  PAGE,
  PAGE_HEADER_DETAIL,
  PAGE_TITLE,
  PILL,
  ROW_LINK,
  ROW_TEXT,
  SECTION,
  SECTION_TITLE,
} from '../shared/layout';
import { initials as initialsOfName } from '../specialists/specialist-ui';

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
  imports: [RouterLink, IconComponent, AlertComponent, EmptyStateComponent],
  host: { class: 'block' },
  template: `
    <div class="${PAGE}">
      <header class="${PAGE_HEADER_DETAIL}">
        <h1 class="${PAGE_TITLE}">Patient details</h1>
        <a routerLink="/patients" class="${BACK_LINK}" aria-label="Back to patients">
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" />Patients
        </a>
      </header>

      @if (loading()) {
        <div class="flex flex-col gap-6" aria-busy="true">
          <span class="sr-only">Loading the patient…</span>
          <div class="sd-shimmer h-56 rounded-card"></div>
          <div class="sd-shimmer h-40 rounded-card"></div>
        </div>
      } @else if (error()) {
        <div class="${EMPTY_FRAME}" role="alert">
          <sd-empty-state icon="user-x" tone="error" title="We couldn't open this patient" [message]="error()">
            <a routerLink="/patients" class="${BTN_SECONDARY}"><sd-icon name="users" [size]="16" />Back to patients</a>
          </sd-empty-state>
        </div>
      } @else if (data(); as d) {
        <section class="${DETAIL_HEADER}" aria-labelledby="bo-patient-name">
          <div class="flex min-w-0 flex-col gap-5">
            <div class="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
              <span class="${DETAIL_AVATAR}" aria-hidden="true">{{ initials(d) }}</span>
              <div class="flex min-w-0 flex-1 flex-col gap-2.5">
                <h2 id="bo-patient-name" class="${DETAIL_NAME}">{{ d.patient.first_name }} {{ d.patient.last_name }}</h2>
                <ul class="flex flex-wrap items-center justify-center gap-2 sm:justify-start" aria-label="Patient summary">
                  @if (d.patient.gender) {
                    <li class="${CHIP} bg-frost capitalize text-cerulean"><sd-icon name="user" [size]="14" /><span class="sr-only">Gender:</span>{{ d.patient.gender }}</li>
                  }
                  @if (d.patient.two_factor_enabled) {
                    <li class="${CHIP} bg-sage/15 text-sage"><sd-icon name="shield-check" [size]="14" />2FA on</li>
                  } @else {
                    <li class="${CHIP} bg-glacier text-ink"><sd-icon name="shield" [size]="14" class="text-slate" />2FA off</li>
                  }
                  <li class="${CHIP} bg-glacier text-ink"><sd-icon name="user-plus" [size]="14" class="text-slate" />Joined {{ when(d.patient.created_at) }}</li>
                </ul>
              </div>
            </div>

            <dl class="${INFO_TILES}">
              <div class="${INFO_TILE}">
                <dt class="${INFO_TILE_LABEL}"><sd-icon name="mail" [size]="16" class="shrink-0" />Email</dt>
                <dd class="${INFO_TILE_VALUE} [overflow-wrap:anywhere]">{{ d.patient.email }}</dd>
              </div>
              <div class="${INFO_TILE}">
                <dt class="${INFO_TILE_LABEL}"><sd-icon name="phone" [size]="16" class="shrink-0" />Phone</dt>
                @if (d.patient.phone) {
                  <dd class="${INFO_TILE_VALUE}">
                    {{ d.patient.phone }}
                    @if (d.patient.phone_verified) {
                      <span class="ml-1 inline-flex items-center gap-0.5 font-sans text-caption font-semibold text-sage"><sd-icon name="circle-check" [size]="13" />Verified</span>
                    }
                  </dd>
                } @else {
                  <dd class="font-sans text-body-sm text-slate">Not provided</dd>
                }
              </div>
              <div class="${INFO_TILE}">
                <dt class="${INFO_TILE_LABEL}"><sd-icon name="calendar-days" [size]="16" class="shrink-0" />Date of birth</dt>
                @if (d.patient.date_of_birth) {
                  <dd class="${INFO_TILE_VALUE}">{{ d.patient.date_of_birth }}</dd>
                } @else {
                  <dd class="font-sans text-body-sm text-slate">Not provided</dd>
                }
              </div>
            </dl>
          </div>
        </section>

        <section class="${SECTION}" aria-labelledby="bo-patient-appts-title">
          <h2 id="bo-patient-appts-title" class="${SECTION_TITLE}">
            <sd-icon name="calendar-days" [size]="20" class="text-cerulean" />Appointments
            <span class="${COUNT_PILL}">{{ d.appointments_total }}</span>
          </h2>
          @if (d.appointments.length === 0) {
            <div class="${LIST_CARD_EMPTY} !py-8">
              <sd-icon name="calendar-x" [size]="28" class="text-slate" />
              <p class="font-sans text-body-sm text-slate">No appointments yet.</p>
            </div>
          } @else {
            <ul class="flex flex-col divide-y divide-cloud">
              @for (a of d.appointments; track a.id) {
                <li class="group relative flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3.5 first:pt-0 last:pb-0">
                  <a [routerLink]="['/appointments', a.id]" class="${ROW_LINK} after:!rounded-field">
                    <span class="${AVATAR_SM}" aria-hidden="true">{{ initialsOfName(a.specialist.name) }}</span>
                    <span class="${ROW_TEXT}">
                      <span class="truncate font-sans text-body-sm font-semibold text-ink transition-colors group-hover:text-cerulean">{{ a.specialist.name }}</span>
                      <span class="truncate font-sans text-caption text-slate">{{ when(a.scheduled_at) }} · {{ a.type_label }}</span>
                    </span>
                  </a>
                  <span class="flex shrink-0 flex-col items-start gap-1 pl-13 sm:items-end sm:pl-0">
                    @if (badge(a); as b) {
                      <span class="${PILL}" [class]="b.cls"><sd-icon [name]="b.icon" [size]="13" />{{ b.label }}</span>
                      @if (a.needs_attention) {
                        <span class="${PILL} ${ATTENTION_BADGE.cls}"><sd-icon name="${ATTENTION_BADGE.icon}" [size]="13" />{{ attention.label }}</span>
                      } @else if (b.detail) {
                        <span class="font-sans text-caption text-slate">{{ b.detail }}</span>
                      }
                    }
                  </span>
                </li>
              }
            </ul>
          }
        </section>

        <section class="${SECTION}" aria-labelledby="bo-patient-rx-title">
          <div class="flex flex-col gap-1">
            <h2 id="bo-patient-rx-title" class="${SECTION_TITLE}">
              <sd-icon name="pill" [size]="20" class="text-cerulean" />Prescriptions
              @if (!rxLoading() && !rxError()) {
                <span class="${COUNT_PILL}">{{ prescriptions().length }}</span>
              }
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
            <div class="flex flex-col gap-3" aria-busy="true" aria-label="Loading prescriptions">
              <div class="sd-shimmer h-16 rounded-field"></div>
              <div class="sd-shimmer h-16 rounded-field"></div>
            </div>
          } @else if (rxError()) {
            <div class="${LIST_CARD_EMPTY} !py-8" role="alert">
              <sd-icon name="wifi-off" [size]="28" class="text-alert" />
              <p class="font-sans text-body-sm text-slate">{{ rxError() }}</p>
              <button type="button" class="${BTN_SECONDARY} mt-1" (click)="loadPrescriptions()">
                <sd-icon name="refresh-cw" [size]="16" />Try again
              </button>
            </div>
          } @else if (prescriptions().length === 0) {
            <div class="${LIST_CARD_EMPTY} !py-8">
              <sd-icon name="pill" [size]="28" class="text-slate" />
              <p class="font-sans text-body-sm text-slate">No prescriptions have been sent to this patient yet.</p>
            </div>
          } @else {
            <ul class="flex flex-col divide-y divide-cloud">
              @for (rx of prescriptions(); track rx.id) {
                <li class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 first:pt-0 last:pb-0">
                  <div class="flex min-w-0 flex-col gap-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="break-all font-sans text-body-sm font-semibold text-ink">{{ rx.number }}</span>
                      <span class="${PILL}" [class]="rxStatus(rx.status).cls">
                        <sd-icon [name]="rxStatus(rx.status).icon" [size]="13" />{{ rxStatus(rx.status).label }}
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
                    class="${BTN_SECONDARY} shrink-0"
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

  /** A doctor's initials for the row avatar ("Dr Jane Doe" → "JD"). */
  protected readonly initialsOfName = initialsOfName;

  /** The appointment's badge: the server's display label (Missed, Not confirmed…) + its detail. */
  protected readonly attention = ATTENTION_BADGE;
  protected badge(a: AppointmentDto): AppointmentBadge {
    return appointmentBadge(a);
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? '—'
      : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
  }
}
