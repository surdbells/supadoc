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
import { AdminAppointmentsApi } from '@supadoc/data-access';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage } from '@supadoc/data-access';
import type { AppointmentDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

/** Allowed next statuses per the API's appointment state machine. */
const TRANSITIONS: Record<string, string[]> = {
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
            <div class="flex justify-between gap-4"><dt class="text-slate">Scheduled</dt><dd class="text-ink">{{ when(a.scheduled_at) }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Type</dt><dd class="text-ink">{{ a.type_label }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Payment</dt><dd class="capitalize text-ink">{{ a.payment_status || '—' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Guests</dt><dd class="text-ink">{{ a.guests?.length || 0 }}</dd></div>
          </dl>

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
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    this.api
      .get(this.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.appt.set(res.data),
        error: () => this.error.set('Appointment not found.'),
      });
  }

  protected setStatus(status: string): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set('');
    this.api
      .updateStatus(this.id, status)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.appt.set(res.data);
          this.noticeOk.set(true);
          this.notice.set('Status updated.');
          this.busy.set(false);
        },
        error: (err) => {
          this.noticeOk.set(false);
          this.notice.set(apiErrorMessage(err, 'Could not update the status.'));
          this.busy.set(false);
        },
      });
  }

  protected label(status: string): string {
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
    const map: Record<string, string> = { pending: 'bg-warning/15 text-warning', confirmed: 'bg-sage/15 text-sage', rescheduled: 'bg-cloud text-slate', completed: 'bg-frost text-cerulean', cancelled: 'bg-alert/10 text-alert' };
    return map[status] ?? 'bg-cloud text-slate';
  }
}
