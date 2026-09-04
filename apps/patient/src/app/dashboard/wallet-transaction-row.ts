import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type { WalletTransactionDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

const TITLES: Record<string, string> = {
  topup: 'Fund Added',
  consultation: 'Consultation Payment',
  refund: 'Refund',
  reversal: 'Reversal',
  adjustment: 'Adjustment',
};

/** One wallet ledger entry, rendered as a card (used by the wallet + history views). */
@Component({
  selector: 'pat-wallet-transaction-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    @if (txn(); as t) {
      <div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 rounded-card border border-cloud bg-white p-4 sm:grid-cols-[auto_1.4fr_1fr_1fr_0.8fr] sm:p-5">
        <!-- Icon -->
        <span
          class="flex size-10 shrink-0 items-center justify-center rounded-full"
          [class]="credit() ? 'bg-sage/15 text-sage' : 'bg-alert/10 text-alert'"
        >
          <sd-icon name="arrow-right" [size]="18" [class]="credit() ? 'rotate-[135deg]' : '-rotate-45'" />
        </span>

        <!-- Title + subtitle -->
        <div class="flex min-w-0 flex-col">
          <span class="font-heading text-body font-semibold text-ink">{{ title() }}</span>
          @if (t.description) {
            <span class="truncate font-sans text-body-sm text-slate">{{ t.description }}</span>
          }
        </div>

        <!-- Date + time -->
        <div class="col-start-2 flex flex-col gap-1 sm:col-start-auto">
          <span class="flex items-center gap-1.5 font-sans text-body-sm text-slate">
            <sd-icon name="calendar-days" [size]="15" /> {{ dateLabel() }}
          </span>
          <span class="flex items-center gap-1.5 font-sans text-body-sm text-slate">
            <sd-icon name="clock" [size]="15" /> {{ timeLabel() }}
          </span>
        </div>

        <!-- Amount + status badge -->
        <div class="col-start-2 flex flex-col items-start gap-1 sm:col-start-auto sm:items-start">
          <span class="font-heading text-body font-semibold" [class]="credit() ? 'text-sage' : 'text-alert'">
            {{ credit() ? '+' : '-' }}{{ amountLabel() }}
          </span>
          <span
            class="rounded-pill px-2.5 py-0.5 font-sans text-caption font-medium"
            [class]="credit() ? 'bg-sage/15 text-sage' : 'bg-alert/10 text-alert'"
          >
            {{ t.label }}
          </span>
        </div>

        <!-- Running balance -->
        <div class="col-start-2 flex flex-col sm:col-start-auto sm:text-right">
          <span class="font-heading text-body font-semibold text-ink">{{ balanceLabel() }}</span>
          <span class="font-sans text-caption text-slate">Wallet Balance</span>
        </div>
      </div>
    }
  `,
})
export class WalletTransactionRow {
  readonly txn = input.required<WalletTransactionDto>();

  protected readonly credit = computed(() => this.txn().direction === 'credit');
  protected readonly title = computed(() => TITLES[this.txn().type] ?? this.txn().label);

  protected readonly amountLabel = computed(() =>
    this.money(this.txn().amount, this.txn().currency, false),
  );
  protected readonly balanceLabel = computed(() =>
    this.txn().balance_after !== null
      ? this.money(this.txn().balance_after as string, this.txn().currency, false)
      : '—',
  );

  protected readonly dateLabel = computed(() => {
    const d = new Date(this.txn().created_at);
    return isNaN(d.getTime())
      ? '—'
      : new Intl.DateTimeFormat('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        }).format(d);
  });
  protected readonly timeLabel = computed(() => {
    const d = new Date(this.txn().created_at);
    return isNaN(d.getTime())
      ? ''
      : new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  });

  private money(amount: string, currency: string, decimals: boolean): string {
    const n = Number(amount);
    if (isNaN(n)) return '';
    try {
      return new Intl.NumberFormat('en-NG', {
        style: 'currency',
        currency,
        minimumFractionDigits: decimals ? 2 : 0,
        maximumFractionDigits: decimals ? 2 : 0,
      }).format(n);
    } catch {
      return `${currency} ${n.toLocaleString('en-NG')}`;
    }
  }
}
