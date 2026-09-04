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
import { WalletApi } from '@supadoc/data-access';
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
    <div class="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header>
        <h1 class="font-heading text-h3 text-ink">My Wallet</h1>
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
      <section class="relative overflow-hidden rounded-card bg-frost/50 p-6 sm:p-7">
        <sd-icon
          name="wallet"
          [size]="150"
          class="pointer-events-none absolute -right-4 top-1/2 -translate-y-1/2 text-white/40"
        />
        <div class="relative flex flex-col gap-5">
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-center gap-1.5 font-sans text-body text-slate">
              Current Balance <sd-icon name="info" [size]="16" class="text-slate/70" />
            </div>
            <span class="flex items-center gap-1.5 rounded-pill bg-white/70 px-3 py-1 font-sans text-caption font-semibold text-sage">
              <span class="size-2 rounded-full bg-sage"></span> Active
            </span>
          </div>

          <div class="flex flex-wrap items-end justify-between gap-4">
            <div class="flex flex-col gap-2">
              @if (loading()) {
                <div class="sd-shimmer h-11 w-48 rounded-lg"></div>
              } @else {
                <p class="font-heading text-h1 tracking-tight text-ocean">
                  {{ balanceLabel() }}
                </p>
              }
              <div class="relative">
                <button
                  type="button"
                  class="flex items-center gap-2 rounded-pill bg-white/70 px-3 py-1.5 font-sans text-body-sm font-medium text-ink transition-colors hover:bg-white"
                  (click)="currencyOpen.set(!currencyOpen())"
                >
                  <span class="text-body" aria-hidden="true">{{ flag() }}</span>
                  {{ currencyName() }}
                  <sd-icon name="chevron-down" [size]="16" class="text-slate" />
                </button>
                @if (currencyOpen()) {
                  <div class="absolute left-0 z-10 mt-1 min-w-40 rounded-field border border-cloud bg-white py-1 shadow-lg">
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
              class="flex items-center gap-2 rounded-field bg-cerulean px-6 py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60"
              [disabled]="loading()"
              (click)="openFund()"
            >
              <sd-icon name="plus" [size]="18" /> Add funds
            </button>
          </div>
        </div>
      </section>

      <!-- Transaction history -->
      <section class="flex flex-col gap-4">
        <div class="flex items-center justify-between gap-4">
          <h2 class="flex items-center gap-2 font-heading text-h5 text-ink">
            <sd-icon name="clipboard-list" [size]="20" class="text-slate" /> Transaction history
          </h2>
          <a
            routerLink="/dashboard/wallet/transactions"
            class="flex items-center gap-2 rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-slate transition-colors hover:border-ash"
          >
            <sd-icon name="filter" [size]="16" /> All
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
        <div class="relative z-10 w-full max-w-lg rounded-card bg-white p-6 shadow-2xl sm:p-8">
          <div class="flex items-center justify-between border-b border-cloud pb-4">
            <h3 class="font-heading text-h4 text-ink">Add Funds</h3>
            <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="closeFund()">
              <sd-icon name="x" [size]="22" />
            </button>
          </div>

          <div class="mt-6 flex flex-col gap-4">
            <label class="font-sans text-body font-medium text-ink">Enter Amount</label>
            <div class="flex items-center gap-2 rounded-field border border-cloud px-4 py-3 focus-within:border-cerulean">
              <span class="font-heading text-h5 text-slate">{{ symbol() }}</span>
              <input
                inputmode="numeric"
                placeholder="0"
                class="w-full min-w-0 bg-transparent font-heading text-h5 text-ink placeholder:text-slate/50 focus:outline-none"
                [value]="amountDisplay()"
                (input)="onAmount($any($event.target).value)"
              />
            </div>

            <div class="flex flex-wrap gap-2.5">
              @for (p of presets; track p) {
                <button
                  type="button"
                  class="rounded-field border px-4 py-2.5 font-sans text-body-sm transition-colors"
                  [class]="amount() === p ? 'border-cerulean bg-frost/50 text-cerulean' : 'border-cloud text-ink hover:border-ash'"
                  (click)="setAmount(p)"
                >
                  {{ preset(p) }}
                </button>
              }
            </div>

            <div class="rounded-card bg-frost/50 p-5">
              <p class="font-sans text-body-sm text-slate">You will receive</p>
              <p class="mt-1 font-heading text-h3 text-cerulean">{{ receiveLabel() }}</p>
              <p class="mt-0.5 font-sans text-caption text-slate">No fee charged</p>
            </div>

            @if (fundError()) {
              <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">{{ fundError() }}</p>
            }

            <button
              type="button"
              class="mt-2 flex items-center justify-center gap-2 rounded-field bg-cerulean px-6 py-3.5 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60"
              [disabled]="funding() || !amountValid()"
              (click)="continueToPayment()"
            >
              {{ funding() ? 'Redirecting…' : 'Continue to payment' }}
            </button>
            <p class="flex items-center justify-center gap-1.5 text-center font-sans text-caption text-slate">
              Secured by <span class="font-label font-semibold text-ink">paystack</span>
            </p>
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
        error: (err: { error?: { message?: string } }) => {
          this.funding.set(false);
          this.fundError.set(err?.error?.message ?? 'Could not start the payment. Please try again.');
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
