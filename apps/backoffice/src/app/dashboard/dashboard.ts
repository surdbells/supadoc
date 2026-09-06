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
import { RouterLink } from '@angular/router';
import { MonitoringApi } from '@supadoc/data-access';
import type { MonitoringOverviewDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

interface Stat {
  readonly label: string;
  readonly value: number | string;
  readonly icon: string;
  readonly hint?: string;
  readonly hintClass?: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  rescheduled: 'Rescheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** Back-office overview (route `/dashboard`) — platform totals at a glance. */
@Component({
  selector: 'bo-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Overview</h1>
        <p class="font-sans text-body text-slate">Live platform activity at a glance.</p>
      </header>

      @if (loading()) {
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          @for (i of [1,2,3,4,5,6]; track i) { <div class="sd-shimmer h-24 rounded-card"></div> }
        </div>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
        </div>
      } @else if (overview(); as o) {
        @if (o.recordings.active > 0) {
          <a routerLink="/monitoring" class="flex items-center gap-3 rounded-card border border-alert/30 bg-alert/5 px-5 py-4 transition-colors hover:bg-alert/10">
            <span class="size-2.5 animate-pulse rounded-full bg-alert"></span>
            <span class="font-sans text-body-sm font-semibold text-alert">{{ o.recordings.active }} consultation{{ o.recordings.active === 1 ? '' : 's' }} recording now</span>
            <sd-icon name="chevron-right" [size]="18" class="ml-auto text-alert" />
          </a>
        }

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          @for (s of stats(); track s.label) {
            <div class="rounded-card border border-cloud bg-white p-4">
              <div class="flex items-center gap-2 text-slate">
                <sd-icon [name]="s.icon" [size]="16" />
                <span class="font-sans text-caption">{{ s.label }}</span>
              </div>
              <p class="mt-1 font-heading text-h4 text-ink">{{ s.value }}</p>
              @if (s.hint) { <p class="font-sans text-caption" [class]="s.hintClass ?? 'text-slate'">{{ s.hint }}</p> }
            </div>
          }
        </div>

        <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
          <h2 class="font-heading text-body-lg text-ink">Appointments by status</h2>
          <div class="flex flex-wrap gap-2">
            @for (row of byStatus(); track row.key) {
              <span class="rounded-pill px-3 py-1.5 font-sans text-body-sm" [class]="statusClass(row.key)">
                {{ row.label }}: <span class="font-semibold">{{ row.count }}</span>
              </span>
            } @empty {
              <span class="font-sans text-body-sm text-slate">No appointments yet.</span>
            }
          </div>
          <a routerLink="/appointments" class="mt-2 flex w-fit items-center gap-1.5 font-sans text-body-sm font-semibold text-cerulean hover:text-ocean">
            Manage appointments <sd-icon name="arrow-right" [size]="16" />
          </a>
        </section>
      }
    </div>
  `,
})
export class AdminDashboard implements OnInit {
  private readonly api = inject(MonitoringApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly overview = signal<MonitoringOverviewDto | null>(null);

  protected readonly stats = computed<Stat[]>(() => {
    const o = this.overview();
    if (!o) return [];
    return [
      { label: 'Appointments', value: o.appointments.total, icon: 'calendar-days' },
      {
        label: 'Recordings',
        value: o.recordings.total,
        icon: 'video',
        hint: o.recordings.active > 0 ? o.recordings.active + ' live now' : 'none live',
        hintClass: o.recordings.active > 0 ? 'text-alert' : 'text-slate',
      },
      { label: 'Clinical notes', value: o.clinical_notes, icon: 'file-text' },
      { label: 'Prescriptions', value: o.prescriptions, icon: 'pill' },
      { label: 'Lab orders', value: o.lab_orders, icon: 'clipboard-list' },
      { label: 'Audit events', value: o.audit_events, icon: 'shield-check' },
    ];
  });

  protected readonly byStatus = computed(() => {
    const o = this.overview();
    if (!o) return [];
    return Object.entries(o.appointments.by_status).map(([key, count]) => ({
      key,
      label: STATUS_LABEL[key] ?? key,
      count,
    }));
  });

  ngOnInit(): void {
    this.api
      .overview()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.overview.set(res.data);
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Could not load the overview.');
          this.loading.set(false);
        },
      });
  }

  protected statusClass(status: string): string {
    const map: Record<string, string> = {
      pending: 'bg-warning/15 text-warning',
      confirmed: 'bg-sage/15 text-sage',
      rescheduled: 'bg-cloud text-slate',
      completed: 'bg-frost text-cerulean',
      cancelled: 'bg-alert/10 text-alert',
    };
    return map[status] ?? 'bg-cloud text-slate';
  }
}
