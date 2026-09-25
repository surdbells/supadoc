import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { DoctorApi } from '@supadoc/data-access';
import type { DoctorAppointmentDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

interface Filter {
  readonly key: string;
  readonly label: string;
  readonly status: string;
}

const FILTERS: Filter[] = [
  { key: 'all', label: 'All', status: '' },
  { key: 'completed', label: 'Completed', status: 'completed' },
  { key: 'cancelled', label: 'Cancelled', status: 'cancelled' },
];

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  confirmed: 'bg-sage/15 text-sage',
  rescheduled: 'bg-cloud text-slate',
  completed: 'bg-sage/15 text-sage',
  cancelled: 'bg-alert/10 text-alert',
};

/** Doctor appointment history (route `/appointments/history`) — All / Completed / Cancelled. */
@Component({
  selector: 'doc-appointment-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Appointment History</h1>
        <p class="font-sans text-body text-slate">Review your past consultations.</p>
      </header>

      <!-- Filter bar -->
      <div class="flex items-center gap-4 rounded-pill border border-cloud bg-white px-2 py-1.5">
        <div class="flex flex-1 gap-1">
          @for (f of filters; track f.key) {
            <button type="button"
              class="rounded-pill px-5 py-2 font-sans text-body-sm font-semibold transition-colors"
              [class]="active() === f.key ? 'bg-frost text-cerulean' : 'text-slate hover:text-ink'"
              (click)="select(f)">
              {{ f.label }}
            </button>
          }
        </div>
        <button type="button" class="shrink-0 pr-3 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean disabled:opacity-40" [disabled]="active() === 'all'" (click)="clearAll()">Clear all</button>
      </div>

      @if (loading() && items().length === 0) {
        <div class="flex flex-col gap-3">
          <div class="sd-shimmer h-20 rounded-card"></div>
          <div class="sd-shimmer h-20 rounded-card"></div>
        </div>
      } @else if (items().length === 0) {
        <div class="flex flex-col items-center gap-3 py-16 text-center">
          <span class="flex size-20 items-center justify-center rounded-full bg-cloud/60 text-slate"><sd-icon name="history" [size]="34" /></span>
          <p class="font-sans text-body-sm text-slate">No past consultations{{ active() === 'all' ? '' : ' in this filter' }}.</p>
        </div>
      } @else {
        <ul class="flex flex-col gap-4">
          @for (a of items(); track a.id) {
            <li>
              <a [routerLink]="['/appointments', a.id]" class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-colors hover:border-cerulean/40 lg:flex-row lg:items-center lg:gap-6">
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
                  <span class="w-fit rounded-pill px-3 py-0.5 font-sans text-caption font-semibold" [class]="statusClass(a.status)">{{ a.status_label }}</span>
                </div>
                <sd-icon name="chevron-right" [size]="22" class="shrink-0 self-center text-slate" />
              </a>
            </li>
          }
        </ul>

        @if (hasMore()) {
          <button type="button" class="mx-auto rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="loading()" (click)="loadMore()">
            {{ loading() ? 'Loading…' : 'Load more' }}
          </button>
        }
      }
    </div>
  `,
})
export class DoctorAppointmentHistory implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly filters = FILTERS;
  protected readonly active = signal('all');
  protected readonly items = signal<DoctorAppointmentDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);
  private page = 1;

  ngOnInit(): void {
    this.fetch();
  }

  protected select(f: Filter): void {
    if (this.active() === f.key) return;
    this.active.set(f.key);
    this.apply();
  }

  protected clearAll(): void {
    if (this.active() === 'all') return;
    this.active.set('all');
    this.apply();
  }

  private apply(): void {
    this.page = 1;
    this.items.set([]);
    this.fetch();
  }

  protected loadMore(): void {
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    const status = this.filters.find((f) => f.key === this.active())?.status || undefined;
    this.api
      .history({ page: this.page, per_page: 20, status })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  protected initialsFor(name: string): string {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }
  protected statusClass(status: string): string {
    return STATUS_CLASS[status] ?? 'bg-cloud text-slate';
  }
  protected dateLabel(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }
  protected time(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
}
