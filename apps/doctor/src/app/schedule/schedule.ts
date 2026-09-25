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

type TabKey = 'upcoming' | 'today' | 'pending';

const STATUS_TEXT: Record<string, string> = {
  pending: 'text-warning',
  confirmed: 'text-sage',
  rescheduled: 'text-warning',
  completed: 'text-cerulean',
  cancelled: 'text-alert',
};

/** The doctor's schedule (route `/schedule`) — Upcoming / Today / Pending tabs. */
@Component({
  selector: 'doc-schedule',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Schedule</h1>
        <p class="font-sans text-body text-slate">View and manage your patient consultations.</p>
      </header>

      @if (notice()) {
        <div class="flex items-center gap-2 rounded-card bg-alert/10 px-4 py-2.5 font-sans text-caption text-alert" role="status">
          <sd-icon name="triangle-alert" [size]="16" />{{ notice() }}
        </div>
      }

      <!-- Tabs -->
      <div class="flex w-fit gap-1 rounded-pill border border-cloud bg-white p-1">
        @for (t of tabs; track t.key) {
          <button type="button"
            class="flex items-center gap-2 rounded-pill px-5 py-2 font-sans text-body-sm font-semibold transition-colors"
            [class]="tab() === t.key ? 'bg-frost text-cerulean' : 'text-slate hover:text-ink'"
            (click)="tab.set(t.key)">
            {{ t.label }}
            @if (count(t.key) > 0) {
              <span class="flex size-5 items-center justify-center rounded-full text-[11px] font-semibold"
                [class]="tab() === t.key ? 'bg-cerulean text-white' : 'bg-cloud text-slate'">{{ count(t.key) }}</span>
            }
          </button>
        }
      </div>

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
      } @else if (visible().length === 0) {
        <!-- Empty state -->
        <div class="flex flex-col items-center gap-5 py-20 text-center">
          <span class="flex size-24 items-center justify-center rounded-full bg-cloud/60 text-slate">
            <sd-icon name="calendar-days" [size]="40" />
          </span>
          <div class="flex max-w-sm flex-col gap-1">
            <h2 class="font-heading text-h5 text-ink">No Appointment yet</h2>
            <p class="font-sans text-body-sm text-slate">{{ emptyText() }}</p>
          </div>
          <a routerLink="/availability" class="rounded-field bg-cerulean px-6 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean">View Availability</a>
        </div>
      } @else {
        <ul class="flex flex-col gap-4">
          @for (a of visible(); track a.id) {
            <li>
              <div class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-colors hover:border-cerulean/40 lg:flex-row lg:items-center lg:gap-6">
                <div class="flex min-w-0 flex-1 items-center gap-3">
                  <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-frost font-heading text-body-sm font-semibold text-cerulean">{{ initialsFor(a.patient_name) }}</span>
                  <div class="flex min-w-0 flex-col">
                    <span class="truncate font-heading text-body-lg text-ink">{{ a.patient_name }}</span>
                    <span class="truncate font-sans text-body-sm text-slate">{{ a.type_label }}</span>
                  </div>
                </div>
                <div class="flex flex-col gap-1 lg:w-44">
                  <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="calendar-days" [size]="16" class="text-slate" />{{ dateLabel(a.scheduled_at) }}</span>
                  <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="clock" [size]="16" class="text-slate" />{{ time(a.scheduled_at) }}</span>
                </div>
                <div class="flex flex-col gap-1.5 lg:w-48">
                  <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="video" [size]="16" class="text-slate" />Video Consultation</span>
                  <span class="w-fit rounded-pill px-3 py-0.5 font-sans text-caption font-semibold" [class]="statusPill(a.status)">{{ a.status_label }}</span>
                </div>
                <div class="flex shrink-0 items-center gap-3">
                  @if (a.status === 'pending' || a.status === 'rescheduled') {
                    <button type="button" class="flex items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="busyId() === a.id" (click)="confirm(a)">
                      {{ busyId() === a.id ? 'Working…' : 'Confirm' }}
                    </button>
                  } @else {
                    <button type="button" class="flex items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="join(a)">
                      <sd-icon name="video" [size]="18" />Join Call
                    </button>
                  }
                  <a [routerLink]="['/appointments', a.id]" class="text-slate transition-colors hover:text-cerulean" aria-label="Open details"><sd-icon name="chevron-right" [size]="22" /></a>
                </div>
              </div>
            </li>
          }
        </ul>
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
  protected readonly appointments = signal<DoctorAppointmentDto[]>([]);
  protected readonly busyId = signal<string | null>(null);
  protected readonly tab = signal<TabKey>('upcoming');

  protected readonly tabs: ReadonlyArray<{ key: TabKey; label: string }> = [
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'today', label: 'Today' },
    { key: 'pending', label: 'Pending' },
  ];

  private readonly buckets = computed(() => {
    const now = Date.now();
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const today: DoctorAppointmentDto[] = [];
    const upcoming: DoctorAppointmentDto[] = [];
    const pending: DoctorAppointmentDto[] = [];
    for (const a of this.appointments()) {
      if (a.status === 'pending' || a.status === 'rescheduled') pending.push(a);
      const t = new Date(a.scheduled_at).getTime();
      if (t >= start.getTime() && t <= end.getTime()) today.push(a);
      else if (t > now && a.status !== 'cancelled' && a.status !== 'completed') upcoming.push(a);
    }
    return { today, upcoming, pending };
  });

  protected count(key: TabKey): number {
    return this.buckets()[key].length;
  }
  protected readonly visible = computed(() => this.buckets()[this.tab()]);
  protected emptyText(): string {
    return this.tab() === 'pending'
      ? 'No consultations are waiting for your confirmation.'
      : this.tab() === 'today'
        ? "You have no consultations scheduled for today."
        : "You haven't received any appointment yet";
  }

  ngOnInit(): void {
    this.api
      .schedule()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
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
          this.appointments.update((list) =>
            list.map((x) => (x.id === a.id ? { ...x, status: res.data.status, status_label: res.data.status_label } : x)),
          );
          this.busyId.set(null);
        },
        error: () => {
          this.notice.set('Could not confirm the appointment.');
          this.busyId.set(null);
        },
      });
  }

  protected join(a: DoctorAppointmentDto): void {
    const marker = '/call/join/';
    const idx = a.join_url.indexOf(marker);
    const token = idx >= 0 ? a.join_url.slice(idx + marker.length) : '';
    if (token) void this.router.navigate(['/call', token]);
    else window.location.href = a.join_url;
  }

  protected initialsFor(name: string): string {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }
  protected statusPill(status: string): string {
    return status === 'confirmed'
      ? 'bg-sage/15 text-sage'
      : status === 'pending' || status === 'rescheduled'
        ? 'bg-warning/15 text-warning'
        : status === 'cancelled'
          ? 'bg-alert/10 text-alert'
          : 'bg-frost text-cerulean';
  }
  protected statusText(status: string): string {
    return STATUS_TEXT[status] ?? 'text-slate';
  }
  protected dateLabel(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }
  protected time(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
}
