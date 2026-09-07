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
import { Router, RouterLink } from '@angular/router';
import { DoctorApi } from '@supadoc/data-access';
import type { DoctorAppointmentDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  confirmed: 'bg-sage/15 text-sage',
  rescheduled: 'bg-cloud text-slate',
  completed: 'bg-frost text-cerulean',
  cancelled: 'bg-alert/10 text-alert',
};

interface Group {
  readonly key: string;
  readonly label: string;
  readonly items: DoctorAppointmentDto[];
}

/** The doctor's schedule (route `/schedule`) — today / upcoming / past, with confirm + join. */
@Component({
  selector: 'doc-schedule',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">
          {{ specialistName() || 'My consultations' }}
        </h1>
        <p class="font-sans text-body text-slate">
          {{ total() }} consultation{{ total() === 1 ? '' : 's' }}
        </p>
      </header>

      @if (notice()) {
        <div
          class="flex items-center gap-2 rounded-card bg-alert/10 px-4 py-2.5 font-sans text-caption text-alert"
          role="status"
        >
          <sd-icon name="triangle-alert" [size]="16" />{{ notice() }}
        </div>
      }

      @if (loading()) {
        <div class="flex flex-col gap-3">
          <div class="sd-shimmer h-24 rounded-card"></div>
          <div class="sd-shimmer h-24 rounded-card"></div>
        </div>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
        </div>
      } @else if (total() === 0) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="calendar-off" [size]="32" class="text-slate" />
          <p class="font-sans text-body-sm text-slate">You have no consultations yet.</p>
        </div>
      } @else {
        @for (group of groups(); track group.key) {
          @if (group.items.length > 0) {
            <section class="flex flex-col gap-3">
              <h2 class="font-heading text-body font-semibold text-slate">
                {{ group.label }} ({{ group.items.length }})
              </h2>
              <ul class="flex flex-col gap-3">
                @for (a of group.items; track a.id) {
                  <li
                    class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div class="flex flex-col gap-1">
                      <span class="flex items-center gap-2 font-heading text-body font-semibold text-ink">
                        <sd-icon name="user-round" [size]="18" class="text-cerulean" />
                        {{ a.patient_name }}
                        <span
                          class="rounded-pill px-2.5 py-0.5 font-sans text-[10px] font-semibold"
                          [class]="statusClass(a.status)"
                          >{{ a.status_label }}</span
                        >
                      </span>
                      <span class="flex items-center gap-2 font-sans text-body-sm text-slate">
                        <sd-icon name="calendar-days" [size]="16" />{{ when(a.scheduled_at) }}
                      </span>
                      @if (a.guests && a.guests.length > 0) {
                        <span class="flex items-center gap-2 font-sans text-caption text-slate">
                          <sd-icon name="users" [size]="14" />{{ a.guests.length }} guest{{
                            a.guests.length === 1 ? '' : 's'
                          }}
                        </span>
                      }
                    </div>
                    <div class="flex shrink-0 flex-wrap items-center gap-2">
                      <a
                        [routerLink]="['/appointments', a.id]"
                        class="flex items-center justify-center gap-2 rounded-field border border-cloud px-4 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean"
                      >
                        <sd-icon name="clipboard-list" [size]="18" />Open chart
                      </a>
                      @if (a.status === 'pending' || a.status === 'rescheduled') {
                        <button
                          type="button"
                          class="flex items-center justify-center gap-2 rounded-field border border-sage px-4 py-2.5 font-sans text-body-sm font-semibold text-sage transition-colors hover:bg-sage/10 disabled:opacity-60"
                          [disabled]="busyId() === a.id"
                          (click)="confirm(a)"
                        >
                          <sd-icon name="circle-check" [size]="18" />{{
                            busyId() === a.id ? 'Working…' : 'Confirm'
                          }}
                        </button>
                        <button
                          type="button"
                          class="flex items-center justify-center gap-2 rounded-field border border-alert px-4 py-2.5 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5 disabled:opacity-60"
                          [disabled]="busyId() === a.id"
                          (click)="decline(a)"
                        >
                          <sd-icon name="x" [size]="18" />Decline
                        </button>
                      }
                      <button
                        type="button"
                        class="flex items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean"
                        (click)="join(a)"
                      >
                        <sd-icon name="video" [size]="18" />Join call
                      </button>
                    </div>
                  </li>
                }
              </ul>
            </section>
          }
        }
      }
    </div>
  `,
})
export class DoctorSchedule implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly specialistName = signal('');
  protected readonly appointments = signal<DoctorAppointmentDto[]>([]);
  protected readonly busyId = signal<string | null>(null);

  protected readonly total = computed(() => this.appointments().length);

  protected readonly groups = computed<Group[]>(() => {
    const now = Date.now();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const today: DoctorAppointmentDto[] = [];
    const upcoming: DoctorAppointmentDto[] = [];
    const past: DoctorAppointmentDto[] = [];
    for (const a of this.appointments()) {
      const t = new Date(a.scheduled_at).getTime();
      if (t >= startOfDay.getTime() && t <= endOfDay.getTime()) today.push(a);
      else if (t > now) upcoming.push(a);
      else past.push(a);
    }
    return [
      { key: 'today', label: 'Today', items: today },
      { key: 'upcoming', label: 'Upcoming', items: upcoming },
      { key: 'past', label: 'Past', items: past },
    ];
  });

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .schedule()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.specialistName.set(res.data.specialist?.name ?? '');
          this.appointments.set(res.data.appointments ?? []);
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Could not load your consultations.');
          this.loading.set(false);
        },
      });
  }

  protected confirm(a: DoctorAppointmentDto): void {
    if (this.busyId()) return;
    this.busyId.set(a.id);
    this.notice.set('');
    this.api
      .confirm(a.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.patchStatus(a.id, res.data.status, res.data.status_label);
          this.busyId.set(null);
        },
        error: () => {
          this.notice.set('Could not confirm the appointment.');
          this.busyId.set(null);
        },
      });
  }

  protected decline(a: DoctorAppointmentDto): void {
    if (this.busyId()) return;
    if (!window.confirm('Decline this appointment? Any payment will be refunded to the patient.')) return;
    this.busyId.set(a.id);
    this.notice.set('');
    this.api
      .decline(a.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.patchStatus(a.id, res.data.status, res.data.status_label);
          this.busyId.set(null);
        },
        error: () => {
          this.notice.set('Could not decline the appointment.');
          this.busyId.set(null);
        },
      });
  }

  private patchStatus(
    id: string,
    status: DoctorAppointmentDto['status'],
    statusLabel: string,
  ): void {
    this.appointments.update((list) =>
      list.map((x) => (x.id === id ? { ...x, status, status_label: statusLabel } : x)),
    );
  }

  /** Route into the in-app cockpit using the token embedded in the join link. */
  protected join(a: DoctorAppointmentDto): void {
    const marker = '/call/join/';
    const idx = a.join_url.indexOf(marker);
    const token = idx >= 0 ? a.join_url.slice(idx + marker.length) : '';
    if (token) void this.router.navigate(['/call', token]);
    else window.location.href = a.join_url;
  }

  protected statusClass(status: string): string {
    return STATUS_CLASS[status] ?? 'bg-cloud text-slate';
  }

  protected when(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  }
}
