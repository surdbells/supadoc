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
        <div class="flex flex-col gap-2">
          <h1 class="font-heading text-h2 text-ink">Transaction history</h1>
          <p class="font-sans text-body text-slate">View all past transactions</p>
        </div>
        <a
          routerLink="/dashboard/wallet"
          class="flex shrink-0 items-center gap-2 font-sans text-body-lg text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="arrow-right" [size]="24" class="rotate-180" /> Back
        </a>
      </header>

      <!-- Filter pills -->
      <div
        class="flex items-center justify-between gap-4 rounded-[32px] border border-[#d1e9fd] bg-glacier px-6 py-3 shadow-[0_2px_1.5px_rgba(33,150,243,0.3)]"
      >
        <div class="flex flex-wrap items-center gap-4">
          @for (f of filters; track f.key) {
            <button
              type="button"
              class="rounded-[24px] px-4 py-2 font-sans text-body font-semibold transition-colors"
              [class]="active() === f.key ? 'bg-cerulean/30 text-cerulean' : 'text-slate hover:bg-frost/40'"
              (click)="select(f)"
            >
              {{ f.label }}
            </button>
          }
        </div>
        <button
          type="button"
          class="shrink-0 px-3 font-sans text-body-sm text-cerulean transition-colors hover:text-ocean"
          (click)="select(filters[0])"
        >
          Clear all
        </button>
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
          <p class="font-sans text-body-sm text-slate">You haven't made any transaction yet.</p>
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
