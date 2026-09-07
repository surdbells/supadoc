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
  { key: 'confirmed', label: 'Confirmed', status: 'confirmed' },
  { key: 'pending', label: 'Pending', status: 'pending' },
];

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  confirmed: 'bg-sage/15 text-sage',
  rescheduled: 'bg-cloud text-slate',
  completed: 'bg-frost text-cerulean',
  cancelled: 'bg-alert/10 text-alert',
};

/** Doctor appointment history (route `/appointments/history`) — filter + search. */
@Component({
  selector: 'doc-appointment-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Appointment history</h1>
        <p class="font-sans text-body text-slate">Your past and upcoming consultations.</p>
      </header>

      <div class="flex flex-wrap items-center gap-3">
        <div class="flex flex-wrap gap-2">
          @for (f of filters; track f.key) {
            <button
              type="button"
              class="rounded-field px-4 py-2 font-sans text-body-sm font-semibold transition-colors"
              [class]="active() === f.key ? 'bg-cerulean/10 text-cerulean' : 'text-slate hover:bg-frost/40'"
              (click)="select(f)"
            >
              {{ f.label }}
            </button>
          }
        </div>
        <div class="relative ml-auto min-w-[220px] flex-1 sm:max-w-xs">
          <sd-icon name="search" [size]="16" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
          <input
            class="w-full rounded-field border border-cloud bg-white py-2 pl-9 pr-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none"
            placeholder="Search patient…"
            [value]="search()"
            (input)="search.set($any($event.target).value)"
            (keydown.enter)="apply()"
          />
        </div>
      </div>

      <div class="overflow-x-auto rounded-card border border-cloud bg-white">
        <table class="w-full min-w-[640px] text-left">
          <thead class="border-b border-cloud font-sans text-caption text-slate">
            <tr>
              <th class="px-4 py-3">Patient</th>
              <th class="px-4 py-3">Scheduled</th>
              <th class="px-4 py-3">Type</th>
              <th class="px-4 py-3">Status</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            @for (a of items(); track a.id) {
              <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                <td class="px-4 py-3 font-medium">{{ a.patient_name }}</td>
                <td class="px-4 py-3 text-slate">{{ when(a.scheduled_at) }}</td>
                <td class="px-4 py-3 text-slate">{{ a.type_label }}</td>
                <td class="px-4 py-3"><span class="rounded-pill px-2.5 py-0.5 text-caption" [class]="statusClass(a.status)">{{ a.status_label }}</span></td>
                <td class="px-4 py-3 text-right">
                  <a [routerLink]="['/appointments', a.id]" class="font-sans text-caption font-semibold text-cerulean hover:underline">Open chart</a>
                </td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="px-4 py-10 text-center font-sans text-body-sm text-slate">{{ loading() ? 'Loading…' : 'No appointments.' }}</td></tr>
            }
          </tbody>
        </table>
      </div>

      @if (hasMore()) {
        <button type="button" class="mx-auto rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="loading()" (click)="loadMore()">
          {{ loading() ? 'Loading…' : 'Load more' }}
        </button>
      }
    </div>
  `,
})
export class DoctorAppointmentHistory implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly filters = FILTERS;
  protected readonly active = signal('all');
  protected readonly search = signal('');
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

  protected apply(): void {
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
    const search = this.search().trim() || undefined;
    this.api
      .history({ page: this.page, per_page: 20, status, search })
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

  protected statusClass(status: string): string {
    return STATUS_CLASS[status] ?? 'bg-cloud text-slate';
  }
  protected when(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
}
