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
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { PrescriptionStatus, PrescriptionSummaryDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { Subscription } from 'rxjs';
import { medicinesLabel, rxDate, RxStatusBadge } from './rx-shared';

interface Filter {
  readonly key: string;
  readonly label: string;
  readonly status: PrescriptionStatus | undefined;
}

const FILTERS: Filter[] = [
  { key: 'all', label: 'All', status: undefined },
  { key: 'draft', label: 'Drafts', status: 'draft' },
  { key: 'active', label: 'Active', status: 'active' },
  { key: 'expired', label: 'Expired', status: 'expired' },
  { key: 'cancelled', label: 'Cancelled', status: 'cancelled' },
];

const PER_PAGE = 20;

/** All my prescriptions (route `/prescriptions`) — filter by status, open one. */
@Component({
  selector: 'doc-prescriptions-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, RxStatusBadge],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Prescriptions</h1>
          <p class="font-sans text-body text-slate">Everything you have prescribed, newest first.</p>
        </div>
        <a
          routerLink="/prescriptions/new"
          class="inline-flex items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-3 font-sans text-body-sm font-semibold text-white shadow-[0_2px_10px_rgba(21,101,192,0.25)] transition-colors hover:bg-cerulean-dark"
        >
          <sd-icon name="plus" [size]="18" /> New prescription
        </a>
      </header>

      <!-- Status filter -->
      <div class="overflow-x-auto rounded-pill border border-cloud bg-white px-2 py-1.5" role="group" aria-label="Filter by status">
        <div class="flex w-max gap-1">
          @for (f of filters; track f.key) {
            <button
              type="button"
              class="shrink-0 rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors sm:px-5"
              [class]="active() === f.key ? 'bg-frost text-cerulean' : 'text-slate hover:text-ink'"
              [attr.aria-pressed]="active() === f.key"
              (click)="select(f)"
            >
              {{ f.label }}
            </button>
          }
        </div>
      </div>

      @if (loading() && items().length === 0) {
        <div class="flex flex-col gap-3" aria-busy="true">
          <span class="sr-only">Loading prescriptions…</span>
          <div class="sd-shimmer h-20 rounded-card"></div>
          <div class="sd-shimmer h-20 rounded-card"></div>
          <div class="sd-shimmer h-20 rounded-card"></div>
        </div>
      } @else if (error() && items().length === 0) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white px-4 py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-field border border-cloud px-4 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean"
            (click)="reload()"
          >
            <sd-icon name="refresh-cw" [size]="16" /> Try again
          </button>
        </div>
      } @else if (items().length === 0) {
        <div class="flex flex-col items-center gap-3 py-16 text-center">
          <span class="flex size-20 items-center justify-center rounded-full bg-cloud/60 text-slate">
            <sd-icon name="pill" [size]="34" />
          </span>
          <p class="font-sans text-body-sm text-slate">
            {{ active() === 'all' ? 'You have not written any prescriptions yet.' : 'No prescriptions in this filter.' }}
          </p>
        </div>
      } @else {
        <p class="font-sans text-caption text-slate">{{ total() }} prescription{{ total() === 1 ? '' : 's' }}</p>
        <ul class="flex flex-col gap-3">
          @for (rx of items(); track rx.id) {
            <li>
              <a
                [routerLink]="['/prescriptions', rx.id]"
                class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-4 shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-colors hover:border-cerulean/40 sm:p-5 lg:flex-row lg:items-center lg:gap-6"
              >
                <div class="flex min-w-0 flex-1 items-center gap-3">
                  <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean" aria-hidden="true">
                    <sd-icon name="pill" [size]="20" />
                  </span>
                  <div class="flex min-w-0 flex-col">
                    <!-- Never "Draft" as a title: the status badge says what state it is in. -->
                    <span class="truncate font-heading text-body-lg text-ink">{{ rx.patient_name || 'Patient' }}</span>
                    <span class="break-all font-sans text-body-sm text-slate">{{ rx.number }}</span>
                  </div>
                </div>
                <div class="flex flex-col gap-1 lg:w-52">
                  <span class="flex items-center gap-2 font-sans text-body-sm text-ink">
                    <sd-icon name="calendar-days" [size]="16" class="text-slate" />
                    {{ rx.sent_at ? 'Sent ' + date(rx.sent_at) : 'Created ' + date(rx.created_at) }}
                  </span>
                  <span class="flex items-center gap-2 font-sans text-body-sm text-ink">
                    <sd-icon name="clock" [size]="16" class="text-slate" />
                    {{ rx.valid_until ? 'Valid until ' + date(rx.valid_until) : 'No end date yet' }}
                  </span>
                </div>
                <div class="flex flex-wrap items-center gap-2 lg:w-44 lg:flex-col lg:items-start">
                  <doc-rx-status-badge [status]="rx.status" />
                  <span class="font-sans text-caption text-slate">{{ medicines(rx.items_count) }}</span>
                </div>
                <sd-icon name="chevron-right" [size]="22" class="hidden shrink-0 self-center text-slate lg:block" />
              </a>
            </li>
          }
        </ul>

        @if (error()) {
          <p class="text-center font-sans text-caption text-alert">{{ error() }}</p>
        }
        @if (hasMore()) {
          <button
            type="button"
            class="mx-auto rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60"
            [disabled]="loading()"
            (click)="loadMore()"
          >
            {{ loading() ? 'Loading…' : 'Load more' }}
          </button>
        }
      }
    </div>
  `,
})
export class PrescriptionsPage implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly filters = FILTERS;
  protected readonly active = signal('all');
  protected readonly items = signal<PrescriptionSummaryDto[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);
  protected readonly error = signal('');
  private page = 1;
  private sub: Subscription | null = null;

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => this.sub?.unsubscribe());
    this.fetch();
  }

  protected select(f: Filter): void {
    if (this.active() === f.key) return;
    this.active.set(f.key);
    this.reload();
  }

  protected reload(): void {
    this.page = 1;
    this.items.set([]);
    this.fetch();
  }

  protected loadMore(): void {
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    const status = this.filters.find((f) => f.key === this.active())?.status;
    const page = this.page;
    this.sub = this.api
      .allPrescriptions({ status, page, per_page: PER_PAGE })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.update((list) => (page === 1 ? res.data : [...list, ...res.data]));
          this.total.set(res.meta?.total ?? res.data.length);
          this.hasMore.set(!!res.meta && res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          if (this.page > 1) this.page -= 1;
          this.error.set(apiErrorMessage(err, 'Could not load your prescriptions. Please try again.'));
          this.loading.set(false);
        },
      });
  }

  protected date(value: string | null): string {
    return rxDate(value);
  }

  protected medicines(n: number): string {
    return medicinesLabel(n);
  }
}
