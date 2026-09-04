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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { apiErrorMessage, WalletApi } from '@supadoc/data-access';
import type { WalletDto, WalletTransactionDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { WalletTransactionRow } from './wallet-transaction-row';

const CURRENCY_NAMES: Record<string, string> = {
  NGN: 'Naira',
  USD: 'US Dollar',
  GHS: 'Cedi',
  ZAR: 'Rand',
  KES: 'Shilling',
};

const CURRENCY_FLAGS: Record<string, string> = {
  NGN: '🇳🇬',
  USD: '🇺🇸',
  GHS: '🇬🇭',
  ZAR: '🇿🇦',
  KES: '🇰🇪',
};

const PRESETS = ['5000', '10000', '25000', '50000', '100000'];

/**
 * Patient wallet (route `/dashboard/wallet`). Shows the balance, funds the wallet
 * through Paystack (redirect flow), and lists recent ledger entries. After the
 * Paystack redirect back here (`?reference=`), it verifies + settles the top-up.
 */
@Component({
  selector: 'pat-wallet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, RouterLink, WalletTransactionRow],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header>
        <h1 class="font-heading text-h2 text-ink">My Wallet</h1>
        <p class="font-sans text-body text-slate">Manage your funds. View balance and transaction</p>
      </header>

      @if (verifying()) {
        <div class="flex items-center gap-3 rounded-card border border-cerulean/20 bg-frost/40 px-5 py-3">
          <span class="size-4 animate-spin rounded-full border-2 border-cerulean/30 border-t-cerulean"></span>
          <span class="font-sans text-body-sm text-ink">Confirming your payment…</span>
        </div>
      }
      @if (notice(); as n) {
        <div
          class="flex items-center gap-2 rounded-card px-5 py-3 font-sans text-body-sm"
          [class]="n.ok ? 'bg-sage/10 text-sage' : 'bg-alert/10 text-alert'"
        >
          <sd-icon [name]="n.ok ? 'circle-check' : 'triangle-alert'" [size]="18" />
          {{ n.text }}
        </div>
      }

      <!-- Balance card -->
      <section
        class="relative flex items-center justify-between gap-4 rounded-card border-[0.5px] border-[#d1e9fd] bg-[#d1e9fd] p-6 shadow-[0_4px_4px_rgba(21,101,192,0.1)]"
      >
        <!-- Decorative stacked-wallet motif (Figma 1633:31710): two overlapping
             wallets in the card's right-of-centre gap, behind the Add funds
             button. Clipped to their own layer so the card itself stays
             un-clipped and the currency menu below can overflow. -->
        <div class="pointer-events-none absolute inset-0 overflow-hidden rounded-card" aria-hidden="true">
          <sd-icon
            name="wallet"
            [size]="118"
            class="absolute right-[39%] top-1/2 -translate-y-[62%] text-white/25"
          />
          <sd-icon
            name="wallet"
            [size]="150"
            class="absolute right-[27%] top-1/2 -translate-y-[42%] text-white/45"
          />
        </div>
        <span
          class="absolute right-6 top-6 flex items-center gap-1.5 rounded-pill bg-white/70 px-3 py-1 font-sans text-caption font-semibold text-sage"
        >
          <span class="size-2 rounded-full bg-sage"></span> Active
        </span>

        <!-- Balance + currency -->
        <div class="relative flex flex-col gap-6">
          <div class="flex flex-col gap-1">
            <span class="flex items-center gap-1.5 font-sans text-body text-slate">
              Current Balance <sd-icon name="info" [size]="16" class="text-slate/70" />
            </span>
            @if (loading()) {
              <div class="sd-shimmer h-10 w-48 rounded-lg"></div>
            } @else {
              <p class="font-heading text-h2 tracking-tight text-ink">{{ balanceLabel() }}</p>
            }
          </div>
          <div class="relative">
            <button
              type="button"
              class="flex items-center gap-2 rounded-lg border-[0.5px] border-ash bg-cloud/50 px-2 py-1 font-sans text-caption text-slate transition-colors hover:bg-cloud"
              (click)="currencyOpen.set(!currencyOpen())"
            >
              <span aria-hidden="true">{{ flag() }}</span>
              {{ currencyName() }}
              <sd-icon name="chevron-down" [size]="16" class="text-slate" />
            </button>
            @if (currencyOpen()) {
              <div class="absolute left-0 z-20 mt-1 min-w-40 rounded-field border border-cloud bg-white py-1 shadow-lg">
                @for (c of currencies(); track c) {
                  <button
                    type="button"
                    class="flex w-full items-center justify-between px-4 py-2 text-left font-sans text-body-sm text-ink hover:bg-glacier"
                    (click)="selectCurrency(c)"
                  >
                    {{ nameOf(c) }}
                    @if (c === currency()) { <sd-icon name="check" [size]="16" class="text-cerulean" /> }
                  </button>
                }
              </div>
            }
          </div>
        </div>

        <button
          type="button"
          class="relative flex shrink-0 items-center gap-2 rounded-[16px] bg-cerulean px-6 py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60"
          [disabled]="loading()"
          (click)="openFund()"
        >
          <sd-icon name="plus" [size]="18" /> Add funds
        </button>
      </section>

      <!-- Transaction history -->
      <section class="flex flex-col gap-4">
        <div class="flex items-center justify-between gap-4">
          <h2 class="flex items-center gap-2 font-sans text-body-lg text-ink">
            <sd-icon name="clipboard-list" [size]="20" class="text-slate" /> Transaction history
          </h2>
          <a
            routerLink="/dashboard/wallet/transactions"
            class="flex w-[150px] items-center justify-between gap-2 rounded-lg border-[0.5px] border-cerulean bg-cerulean/5 px-4 py-2 font-sans text-body-sm text-ink transition-colors hover:bg-cerulean/10"
          >
            <span class="flex items-center gap-2"><sd-icon name="filter" [size]="16" /> All</span>
            <sd-icon name="chevron-down" [size]="16" class="text-slate" />
          </a>
        </div>

        @if (loading()) {
          <div class="flex flex-col gap-3">
            <div class="sd-shimmer h-20 rounded-card"></div>
            <div class="sd-shimmer h-20 rounded-card"></div>
          </div>
        } @else if (recent().length === 0) {
          <div class="flex flex-col items-center gap-3 py-12 text-center">
            <span class="flex size-16 items-center justify-center rounded-full bg-cloud text-slate">
              <sd-icon name="wallet" [size]="30" />
            </span>
            <p class="font-heading text-body-lg font-semibold text-ink">Your wallet is empty</p>
            <p class="max-w-md font-sans text-body-sm text-slate">
              You have no fund in your wallet yet. Add funds to book consultation and other services.
            </p>
            <button
              type="button"
              class="mt-4 flex w-full max-w-xl items-center justify-center gap-2 rounded-field bg-cerulean px-6 py-4 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean"
              (click)="openFund()"
            >
              <sd-icon name="plus" [size]="18" /> Add funds
            </button>
            <a
              routerLink="/dashboard/wallet/transactions"
              class="mt-1 flex items-center justify-center gap-1.5 py-1 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean"
            >
              View all transactions <sd-icon name="arrow-right" [size]="16" />
            </a>
          </div>
        } @else {
          <ul class="flex flex-col gap-3">
            @for (t of recent(); track t.id) {
              <li><pat-wallet-transaction-row [txn]="t" /></li>
            }
          </ul>
          <a
            routerLink="/dashboard/wallet/transactions"
            class="flex items-center justify-center gap-1.5 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean"
          >
            View all transactions <sd-icon name="arrow-right" [size]="16" />
          </a>
        }
      </section>
    </div>

    <!-- Add funds modal -->
    @if (fundOpen()) {
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="closeFund()"></button>
        <div
          class="relative z-10 flex w-full max-w-[560px] flex-col gap-6 rounded-[16px] border-[0.5px] border-[#d1e9fd] bg-white px-6 py-8 shadow-[0_4px_4px_rgba(21,101,192,0.1)]"
        >
          <div class="flex w-full flex-col gap-6">
            <div class="flex items-center justify-between">
              <h3 class="font-sans text-h5 font-medium text-ink">Add Funds</h3>
              <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="closeFund()">
                <sd-icon name="x" [size]="24" />
              </button>
            </div>
            <hr class="border-t border-cloud" />
          </div>

          <div class="flex flex-col gap-8">
            <div class="flex flex-col gap-4">
              <div class="flex flex-col gap-2">
                <label class="font-sans text-body text-ink">Enter Amount</label>
                <div class="flex items-center justify-center gap-1 rounded-[16px] border-[0.5px] border-slate px-4 py-2.5">
                  <span class="font-sans text-body-lg text-ink">{{ symbol() }}</span>
                  <input
                    inputmode="numeric"
                    placeholder="0"
                    class="w-full min-w-0 bg-transparent text-center font-sans text-body-lg text-ink placeholder:text-slate/50 focus:outline-none"
                    [value]="amountDisplay()"
                    (input)="onAmount($any($event.target).value)"
                  />
                </div>
              </div>

              <div class="flex flex-wrap gap-4">
                @for (p of presets; track p) {
                  <button
                    type="button"
                    class="rounded-[12px] border-[0.5px] px-3 py-2 font-sans text-caption transition-colors"
                    [class]="amount() === p ? 'border-cerulean bg-[#d1e9fd] text-cerulean' : 'border-ash text-ink hover:border-slate'"
                    (click)="setAmount(p)"
                  >
                    {{ preset(p) }}
                  </button>
                }
              </div>
            </div>

            <div class="flex flex-col gap-[7px] rounded-[16px] bg-[#d1e9fd] px-4 py-3.5">
              <p class="font-sans text-body-sm text-slate">You will receive</p>
              <p class="font-sans text-h4 font-semibold text-cerulean">{{ receiveLabel() }}</p>
              <p class="font-sans text-caption text-slate">No fee charged</p>
            </div>

            @if (fundError()) {
              <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">{{ fundError() }}</p>
            }

            <div class="flex flex-col items-center gap-6">
              <button
                type="button"
                class="flex w-full items-center justify-center gap-2 rounded-[16px] bg-cerulean px-4 py-3 font-sans text-body-sm font-medium text-white transition-colors hover:bg-ocean disabled:opacity-60"
                [disabled]="funding() || !amountValid()"
                (click)="continueToPayment()"
              >
                {{ funding() ? 'Redirecting…' : 'Continue to payment' }}
              </button>
              <p class="flex items-center gap-2.5 text-center font-sans text-caption text-slate">
                Secured by <span class="font-label font-semibold text-ink">paystack</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    }
  `,
})
export class Wallet implements OnInit {
  private readonly api = inject(WalletApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly verifying = signal(false);
  protected readonly wallet = signal<WalletDto | null>(null);
  protected readonly notice = signal<{ ok: boolean; text: string } | null>(null);

  protected readonly currency = signal('NGN');
  protected readonly currencyOpen = signal(false);

  protected readonly fundOpen = signal(false);
  protected readonly amount = signal('');
  protected readonly funding = signal(false);
  protected readonly fundError = signal('');

  protected readonly presets = PRESETS;

  protected readonly recent = computed(() => this.wallet()?.recent ?? []);
  protected readonly currencies = computed(() => this.wallet()?.currencies ?? ['NGN']);
  protected readonly currencyName = computed(() => this.nameOf(this.currency()));
  protected readonly flag = computed(() => CURRENCY_FLAGS[this.currency()] ?? '');
  protected readonly balanceLabel = computed(() =>
    this.format(this.wallet()?.balance ?? '0', this.currency(), true),
  );
  protected readonly symbol = computed(() => this.currencySymbol(this.currency()));
  protected readonly amountValid = computed(() => Number(this.amount()) > 0);
  protected readonly amountDisplay = computed(() =>
    this.amount() ? Number(this.amount()).toLocaleString('en-NG') : '',
  );
  protected readonly receiveLabel = computed(() =>
    this.format(this.amount() || '0', this.currency(), false),
  );

  ngOnInit(): void {
    // Returning from Paystack? Verify + settle, then clean the URL.
    const ref =
      this.route.snapshot.queryParamMap.get('reference') ??
      this.route.snapshot.queryParamMap.get('trxref');
    if (ref) {
      this.verifying.set(true);
      this.api
        .verify(ref)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (res) => {
            this.verifying.set(false);
            this.notice.set(
              res.data.status === 'success'
                ? { ok: true, text: 'Wallet funded successfully.' }
                : { ok: false, text: 'Payment was not completed.' },
            );
            void this.router.navigate([], { queryParams: {}, replaceUrl: true });
            this.load();
          },
          error: () => {
            this.verifying.set(false);
            this.notice.set({ ok: false, text: 'We could not confirm the payment.' });
            this.load();
          },
        });
    }
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.api
      .wallet(this.currency())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.wallet.set(res.data);
          this.currency.set(res.data.currency);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  protected selectCurrency(c: string): void {
    this.currency.set(c);
    this.currencyOpen.set(false);
    this.load();
  }

  protected openFund(): void {
    if (this.wallet() && this.wallet()!.funding_ready === false) {
      this.notice.set({ ok: false, text: 'Wallet funding is not enabled on this environment yet.' });
      return;
    }
    this.fundError.set('');
    this.amount.set('25000');
    this.fundOpen.set(true);
  }

  protected closeFund(): void {
    this.fundOpen.set(false);
  }

  protected onAmount(value: string): void {
    this.amount.set(value.replace(/[^0-9]/g, ''));
    this.fundError.set('');
  }

  protected setAmount(v: string): void {
    this.amount.set(v);
    this.fundError.set('');
  }

  protected preset(v: string): string {
    return this.format(v, this.currency(), false);
  }

  protected continueToPayment(): void {
    if (!this.amountValid() || this.funding()) return;
    this.funding.set(true);
    this.fundError.set('');
    this.api
      .fund(this.amount(), this.currency())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          // Hand off to Paystack's hosted checkout.
          window.location.href = res.data.authorization_url;
        },
        error: (err: unknown) => {
          this.funding.set(false);
          this.fundError.set(apiErrorMessage(err, 'Could not start the payment. Please try again.'));
        },
      });
  }

  protected nameOf(code: string): string {
    return CURRENCY_NAMES[code] ?? code;
  }

  private currencySymbol(code: string): string {
    try {
      const parts = new Intl.NumberFormat('en-NG', {
        style: 'currency',
        currency: code,
      }).formatToParts(0);
      return parts.find((p) => p.type === 'currency')?.value ?? code;
    } catch {
      return code;
    }
  }

  private format(amount: string, currency: string, decimals: boolean): string {
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
