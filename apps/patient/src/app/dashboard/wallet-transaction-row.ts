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

/** One wallet ledger entry, rendered exactly per the Figma "History Card". */
@Component({
  selector: 'pat-wallet-transaction-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    @if (txn(); as t) {
      <div
        class="flex flex-col gap-3 rounded-[24px] border-[0.5px] border-[#d1e9fd] bg-white p-5 shadow-[0_4px_2px_rgba(21,101,192,0.05)] sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-6"
      >
        <!-- Icon + title/subtitle -->
        <div class="flex items-center gap-4 sm:gap-5">
          <span
            class="flex shrink-0 items-center justify-center rounded-full p-2"
            [class]="credit() ? 'bg-sage/10 text-sage' : 'bg-alert/10 text-alert'"
          >
            <sd-icon name="arrow-right" [size]="24" [class]="credit() ? 'rotate-[135deg]' : '-rotate-45'" />
          </span>
          <div class="flex min-w-0 flex-col gap-1">
            <span class="font-sans text-body-lg text-ink">{{ title() }}</span>
            @if (t.description) {
              <span class="truncate font-sans text-body-sm text-slate">{{ t.description }}</span>
            }
          </div>
        </div>

        <!-- Date + time -->
        <div class="flex flex-col gap-2 sm:w-[150px] sm:shrink-0">
          <span class="flex items-center gap-2 font-sans text-body-sm text-slate">
            <sd-icon name="calendar-days" [size]="18" class="text-slate" /> {{ dateLabel() }}
          </span>
          <span class="flex items-center gap-2 font-sans text-body-sm text-slate">
            <sd-icon name="clock" [size]="18" class="text-slate" /> {{ timeLabel() }}
          </span>
        </div>

        <!-- Amount + status badge -->
        <div class="flex flex-col items-start justify-center gap-1">
          <span class="font-sans text-body-lg" [class]="credit() ? 'text-sage' : 'text-alert'">
            {{ credit() ? '+' : '-' }}{{ amountLabel() }}
          </span>
          <span
            class="rounded-[12px] px-4 py-1.5 font-sans text-body-sm"
            [class]="credit() ? 'bg-sage/10 text-sage' : 'bg-alert/10 text-alert'"
          >
            {{ t.label }}
          </span>
        </div>

        <!-- Running balance -->
        <div class="flex flex-col justify-center gap-1 sm:w-[135px] sm:shrink-0 sm:text-center">
          <span class="font-sans text-body-lg text-ink">{{ balanceLabel() }}</span>
          <span class="font-sans text-body-sm text-slate">Wallet Balance</span>
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
