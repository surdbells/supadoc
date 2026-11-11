import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { apiErrorMessage, WalletApi } from '@supadoc/data-access';
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
    <div class="flex flex-col gap-6 py-2">
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
        class="sd-track sd-track-l justify-between"
      >
        <!-- One row, never wraps: on a phone the track scrolls sideways (a wrapped group would draw a tall capsule). -->
        <div #filterGroup class="flex shrink-0 items-center gap-4 max-sm:gap-2" role="group" aria-label="Filter transactions">
          @for (f of filters; track f.key) {
            <button
              type="button"
              class="sd-pill sd-pill-l sd-seg"
              [attr.aria-pressed]="active() === f.key"
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
      } @else if (loadError() && txns().length === 0) {
        <div class="flex flex-col items-center gap-3 py-20 text-center">
          <p class="max-w-md font-sans text-body-sm text-alert">{{ loadError() }}</p>
          <button
            type="button"
            class="rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean"
            (click)="reload()"
          >
            Try again
          </button>
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
        @if (loadError()) {
          <p class="text-center font-sans text-body-sm text-alert">{{ loadError() }}</p>
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
export class WalletTransactions implements OnInit {
  private readonly api = inject(WalletApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly filterGroup =
    viewChild<ElementRef<HTMLElement>>('filterGroup');

  protected readonly filters = FILTERS;
  protected readonly active = signal('all');
  protected readonly txns = signal<WalletTransactionDto[]>([]);
  protected readonly loading = signal(true);
  /** Why the last page failed to load ('' when it didn't). */
  protected readonly loadError = signal('');
  protected readonly hasMore = signal(false);

  private page = 1;

  ngOnInit(): void {
    this.reload();
  }

  protected select(f: Filter): void {
    if (this.active() === f.key) return;
    this.active.set(f.key);
    this.reload();
    // The selected pill is scrolled into view in its track (tailwind/pills.css): on a
    // phone the track scrolls, and "Clear all" selects "All", which may be out of sight.
    afterNextRender(
      () => {
        const pill = this.filterGroup()?.nativeElement.querySelector<HTMLElement>(
          '[aria-pressed="true"]',
        );
        const still =
          typeof matchMedia === 'function' &&
          matchMedia('(prefers-reduced-motion: reduce)').matches;
        pill?.scrollIntoView?.({
          block: 'nearest',
          inline: 'nearest',
          behavior: still ? 'auto' : 'smooth',
        });
      },
      { injector: this.injector },
    );
  }

  protected reload(): void {
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
    this.loadError.set('');
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
        error: (err: unknown) => {
          this.loadError.set(apiErrorMessage(err, 'Could not load your transactions.'));
          this.loading.set(false);
        },
      });
  }
}
