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
import { WalletApi } from '@supadoc/data-access';
import type { WalletTransactionDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { WalletTransactionRow } from './wallet-transaction-row';

interface Filter {
  readonly key: string;
  readonly label: string;
  readonly type: string;
}

const FILTERS: Filter[] = [
  { key: 'all', label: 'All', type: '' },
  { key: 'topup', label: 'Top up', type: 'topup' },
  { key: 'consultation', label: 'Paid out', type: 'consultation' },
  { key: 'refund', label: 'Refund', type: 'refund' },
];

/** Full wallet ledger with filters (route `/dashboard/wallet/transactions`). */
@Component({
  selector: 'pat-wallet-transactions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, RouterLink, WalletTransactionRow],
  host: { class: 'block' },
  template: `
    <div class="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="font-heading text-h3 text-ink">Transaction history</h1>
          <p class="font-sans text-body text-slate">View all past transactions.</p>
        </div>
        <a
          routerLink="/dashboard/wallet"
          class="flex shrink-0 items-center gap-1.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="arrow-right" [size]="18" class="rotate-180" /> Back
        </a>
      </header>

      <!-- Filter pills -->
      <div class="flex items-center justify-between gap-4 rounded-pill border border-cloud bg-white px-2 py-2">
        <div class="flex flex-wrap items-center gap-1">
          @for (f of filters; track f.key) {
            <button
              type="button"
              class="rounded-pill px-4 py-2 font-sans text-body-sm transition-colors"
              [class]="active() === f.key ? 'bg-frost font-semibold text-cerulean' : 'text-slate hover:bg-glacier'"
              (click)="select(f)"
            >
              {{ f.label }}
            </button>
          }
        </div>
        @if (active() !== 'all') {
          <button
            type="button"
            class="shrink-0 px-3 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean"
            (click)="select(filters[0])"
          >
            Clear all
          </button>
        }
      </div>

      @if (loading() && txns().length === 0) {
        <div class="flex flex-col gap-3">
          <div class="sd-shimmer h-20 rounded-card"></div>
          <div class="sd-shimmer h-20 rounded-card"></div>
        </div>
      } @else if (txns().length === 0) {
        <div class="flex flex-col items-center gap-3 py-20 text-center">
          <span class="flex size-16 items-center justify-center rounded-full bg-glacier text-slate">
            <sd-icon name="wallet" [size]="30" />
          </span>
          <p class="font-heading text-body-lg font-semibold text-ink">No transaction history</p>
          <p class="font-sans text-body-sm text-slate">You haven't made any transactions yet.</p>
        </div>
      } @else {
        <ul class="flex flex-col gap-3">
          @for (t of txns(); track t.id) {
            <li><pat-wallet-transaction-row [txn]="t" /></li>
          }
        </ul>
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
export class WalletTransactions implements OnInit {
  private readonly api = inject(WalletApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly filters = FILTERS;
  protected readonly active = signal('all');
  protected readonly txns = signal<WalletTransactionDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);

  private page = 1;

  ngOnInit(): void {
    this.reload();
  }

  protected select(f: Filter): void {
    if (this.active() === f.key) return;
    this.active.set(f.key);
    this.reload();
  }

  private reload(): void {
    this.page = 1;
    this.txns.set([]);
    this.fetch();
  }

  protected loadMore(): void {
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    const type = this.filters.find((f) => f.key === this.active())?.type || undefined;
    this.api
      .transactions({ type, page: this.page, per_page: 15 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.txns.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }
}
