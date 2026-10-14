import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, distinctUntilChanged, map, of, switchMap, tap } from 'rxjs';
import { AdminAppointmentsApi } from '@supadoc/data-access';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage } from '@supadoc/data-access';
import type { AppointmentDto, FollowUpPriceDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

/**
 * Allowed next statuses per the API's appointment state machine. A follow-up
 * proposal is only confirmed by the patient accepting (and paying for) it, so
 * staff can just cancel one.
 */
const TRANSITIONS: Record<string, string[]> = {
  proposed: ['cancelled'],
  pending: ['confirmed', 'rescheduled', 'cancelled'],
  confirmed: ['completed', 'rescheduled', 'cancelled'],
  rescheduled: ['confirmed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirm',
  completed: 'Mark completed',
  rescheduled: 'Mark rescheduled',
  cancelled: 'Cancel',
};

/** One appointment (route `/appointments/:id`) with status transitions. */
@Component({
  selector: 'bo-appointment-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <a routerLink="/appointments" class="flex w-fit items-center gap-1 font-sans text-body-sm text-slate transition-colors hover:text-cerulean">
        <sd-icon name="chevron-right" [size]="16" class="rotate-180" /> Appointments
      </a>

      @if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="calendar-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
        </div>
      } @else if (appt(); as a) {
        <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="flex flex-col gap-1">
              <span class="flex items-center gap-2 font-heading text-h5 text-ink">
                {{ a.specialist.name }}
                <span class="rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold" [class]="statusClass(a.status)">{{ a.status_label }}</span>
              </span>
              <span class="font-sans text-body-sm text-slate">{{ a.specialist.specialty }}</span>
            </div>
            <span class="font-heading text-h5 text-ink">{{ money(a.amount) }}</span>
          </div>

          <dl class="grid grid-cols-1 gap-x-8 gap-y-2 font-sans text-body-sm sm:grid-cols-2">
            <div class="flex justify-between gap-4"><dt class="text-slate">Patient</dt><dd class="text-ink">{{ a.patient?.name || '—' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Patient email</dt><dd class="text-ink">{{ a.patient?.email || '—' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Scheduled</dt><dd class="text-ink">{{ when(a.scheduled_at) }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Type</dt><dd class="text-ink">{{ a.type_label }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Payment</dt><dd class="capitalize text-ink">{{ a.payment_status || '—' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Guests</dt><dd class="text-ink">{{ a.guests?.length || 0 }}</dd></div>
          </dl>

          <!-- Follow-ups: the consultation it follows, who created it, how it was priced -->
          @if (a.parent_appointment_id) {
            <div class="flex flex-col gap-2 rounded-field border border-teal/30 bg-teal/5 px-4 py-3 font-sans text-body-sm">
              <a [routerLink]="['/appointments', a.parent_appointment_id]" class="flex w-fit items-center gap-2 font-semibold text-cerulean hover:underline">
                <sd-icon name="refresh-cw" [size]="16" />
                Follow-up of the {{ a.parent ? when(a.parent.scheduled_at) : 'earlier' }} consultation
              </a>
              <dl class="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
                <div class="flex justify-between gap-4"><dt class="text-slate">Created by</dt><dd class="text-ink">{{ proposedByLabel(a) }}</dd></div>
                @if (a.follow_up_pricing; as fp) {
                  <div class="flex justify-between gap-4"><dt class="text-slate">Pricing</dt><dd class="text-right text-ink">{{ pricingLabel(fp) }}</dd></div>
                }
                @if (a.status === 'proposed' && a.expires_at) {
                  <div class="flex justify-between gap-4"><dt class="text-slate">Patient must answer by</dt><dd class="text-ink">{{ when(a.expires_at) }}</dd></div>
                }
              </dl>
            </div>
          }

          @if (a.notes) {
            <div class="rounded-field bg-glacier px-4 py-3 font-sans text-body-sm text-ink">
              <span class="font-semibold text-slate">Notes: </span>{{ a.notes }}
            </div>
          }
        </section>

        <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
          <h2 class="font-heading text-body-lg text-ink">Update status</h2>
          @if (!canUpdate()) {
            <p class="font-sans text-body-sm text-slate">Your account can view but not change appointment status.</p>
          } @else if (nextStatuses().length === 0) {
            <p class="font-sans text-body-sm text-slate">This appointment is in a final state.</p>
          } @else {
            <div class="flex flex-wrap gap-2">
              @for (s of nextStatuses(); track s) {
                <button
                  type="button"
                  class="rounded-field px-4 py-2 font-sans text-body-sm font-semibold transition-colors disabled:opacity-60"
                  [class]="s === 'cancelled' ? 'border border-alert text-alert hover:bg-alert/5' : 'bg-cerulean text-white hover:bg-ocean'"
                  [disabled]="busy()"
                  (click)="setStatus(s)"
                >
                  {{ label(s) }}
                </button>
              }
            </div>
          }
          @if (notice()) { <p class="font-sans text-caption" [class]="noticeOk() ? 'text-sage' : 'text-alert'">{{ notice() }}</p> }
        </section>
      } @else {
        <div class="sd-shimmer h-40 rounded-card"></div>
      }
    </div>
  `,
})
export class AdminAppointmentDetail implements OnInit {
  private readonly api = inject(AdminAppointmentsApi);
  private readonly auth = inject(StaffAuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  private id = '';
  protected readonly appt = signal<AppointmentDto | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal('');
  protected readonly noticeOk = signal(false);

  protected readonly canUpdate = computed(() => this.auth.hasPermission('appointments.update'));
  protected readonly nextStatuses = computed(() => TRANSITIONS[this.appt()?.status ?? ''] ?? []);

  ngOnInit(): void {
    // The follow-up -> parent link stays on this route, so the component is
    // reused: follow the param rather than reading the snapshot once.
    this.route.paramMap
      .pipe(
        map((p) => p.get('id') ?? ''),
        distinctUntilChanged(),
        tap((id) => {
          this.id = id;
          this.appt.set(null);
          this.error.set('');
          this.notice.set('');
        }),
        switchMap((id) =>
          this.api.get(id).pipe(
            map((res) => ({ appt: res.data, error: '' })),
            catchError((err: unknown) => of({ appt: null, error: apiErrorMessage(err, 'Appointment not found.') })),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ appt, error }) => {
        this.appt.set(appt);
        this.error.set(error);
      });
  }

  protected setStatus(status: string): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set('');
    const id = this.id;
    this.api
      .updateStatus(id, status)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          if (id !== this.id) return; // moved to another appointment meanwhile
          this.appt.set(res.data);
          this.noticeOk.set(true);
          this.notice.set('Status updated.');
        },
        error: (err) => {
          this.busy.set(false);
          if (id !== this.id) return;
          this.noticeOk.set(false);
          this.notice.set(apiErrorMessage(err, 'Could not update the status.'));
        },
      });
  }

  protected label(status: string): string {
    if (status === 'cancelled' && this.appt()?.status === 'proposed') return 'Cancel proposal';
    return STATUS_LABEL[status] ?? status;
  }
  protected when(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
  }
  protected money(amount: string): string {
    const n = Number(amount);
    return isNaN(n) ? '—' : '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  protected statusClass(status: string): string {
    const map: Record<string, string> = { proposed: 'bg-teal/10 text-teal', pending: 'bg-warning/15 text-warning', confirmed: 'bg-sage/15 text-sage', rescheduled: 'bg-cloud text-slate', completed: 'bg-frost text-cerulean', cancelled: 'bg-alert/10 text-alert' };
    return map[status] ?? 'bg-cloud text-slate';
  }
  protected proposedByLabel(a: AppointmentDto): string {
    if (a.proposed_by === 'doctor') return a.status === 'proposed' ? 'Doctor (awaiting patient)' : 'Doctor';
    return a.proposed_by === 'patient' ? 'Patient' : '—';
  }
  /** "50% off ₦10,000.00 (within 14 days)", "Waived by the doctor", … */
  protected pricingLabel(p: FollowUpPriceDto): string {
    switch (p.rule) {
      case 'waived':
        return 'Waived by the doctor';
      case 'free':
        return `Free (within ${p.window_days} days)`;
      case 'percent':
        return `${p.discount_percent}% off ${this.money(p.base_fee)} (within ${p.window_days} days)`;
      case 'full':
        return `Full fee (within ${p.window_days} days)`;
      case 'outside_window':
        return `Full fee (after the ${p.window_days}-day window)`;
      default:
        return '—';
    }
  }
}
