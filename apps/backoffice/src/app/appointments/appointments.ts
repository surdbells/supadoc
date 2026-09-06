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
import { AdminAppointmentsApi } from '@supadoc/data-access';
import { StaffAuthService } from '@supadoc/auth';
import type { AppointmentDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

interface Filter {
  readonly key: string;
  readonly label: string;
  readonly status: string;
}

const FILTERS: Filter[] = [
  { key: 'all', label: 'All', status: '' },
  { key: 'pending', label: 'Pending', status: 'pending' },
  { key: 'confirmed', label: 'Confirmed', status: 'confirmed' },
  { key: 'completed', label: 'Completed', status: 'completed' },
  { key: 'cancelled', label: 'Cancelled', status: 'cancelled' },
];

/** Appointments management (route `/appointments`) — list, filter, drill in. */
@Component({
  selector: 'bo-appointments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Appointments</h1>
          <p class="font-sans text-body text-slate">Every consultation across the platform.</p>
        </div>
        @if (canCreate()) {
          <a routerLink="/appointments/new" class="flex shrink-0 items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean">
            <sd-icon name="plus" [size]="18" />New appointment
          </a>
        }
      </header>

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

      <div class="overflow-x-auto rounded-card border border-cloud bg-white">
        <table class="w-full min-w-[720px] text-left">
          <thead class="border-b border-cloud font-sans text-caption text-slate">
            <tr>
              <th class="px-4 py-3">Specialist</th>
              <th class="px-4 py-3">Scheduled</th>
              <th class="px-4 py-3">Type</th>
              <th class="px-4 py-3">Amount</th>
              <th class="px-4 py-3">Payment</th>
              <th class="px-4 py-3">Status</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            @for (a of items(); track a.id) {
              <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                <td class="px-4 py-3">
                  <span class="font-medium">{{ a.specialist.name }}</span>
                  <span class="block text-caption text-slate">{{ a.specialist.specialty }}</span>
                </td>
                <td class="px-4 py-3 text-slate">{{ when(a.scheduled_at) }}</td>
                <td class="px-4 py-3 text-slate">{{ a.type_label }}</td>
                <td class="px-4 py-3">{{ money(a.amount) }}</td>
                <td class="px-4 py-3 capitalize text-slate">{{ a.payment_status || '—' }}</td>
                <td class="px-4 py-3"><span class="rounded-pill px-2.5 py-0.5 text-caption" [class]="statusClass(a.status)">{{ a.status_label }}</span></td>
                <td class="px-4 py-3 text-right">
                  <a [routerLink]="['/appointments', a.id]" class="font-sans text-caption font-semibold text-cerulean hover:underline">Open</a>
                </td>
              </tr>
            } @empty {
              <tr><td colspan="7" class="px-4 py-10 text-center font-sans text-body-sm text-slate">{{ loading() ? 'Loading…' : 'No appointments.' }}</td></tr>
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
export class AdminAppointments implements OnInit {
  private readonly api = inject(AdminAppointmentsApi);
  private readonly auth = inject(StaffAuthService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly canCreate = computed(() => this.auth.hasPermission('appointments.create'));
  protected readonly filters = FILTERS;
  protected readonly active = signal('all');
  protected readonly items = signal<AppointmentDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);
  private page = 1;

  ngOnInit(): void {
    this.fetch();
  }

  protected select(f: Filter): void {
    if (this.active() === f.key) return;
    this.active.set(f.key);
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
      .list({ page: this.page, per_page: 20, status })
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

  protected when(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
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
