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
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type {
  EarningsSummaryDto,
  PayoutAccountDto,
  PayoutDto,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

const FIELD =
  'w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20';

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  approved: 'bg-frost text-cerulean',
  paid: 'bg-sage/15 text-sage',
  rejected: 'bg-alert/10 text-alert',
};

/** Doctor payouts (route `/payouts`) — beneficiary, request, and history. */
@Component({
  selector: 'doc-payouts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Payouts</h1>
        <p class="font-sans text-body text-slate">Withdraw your available earnings to your bank.</p>
      </header>

      @if (loading()) {
        <div class="sd-shimmer h-28 rounded-card"></div>
      } @else {
        <!-- Balance + request -->
        <section class="flex flex-col gap-4 rounded-card border border-cerulean/30 bg-frost/20 p-6">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="flex flex-col gap-1">
              <span class="font-sans text-caption text-slate">Available to withdraw</span>
              <span class="font-heading text-h2 text-cerulean">{{ money(available()) }}</span>
            </div>
            @if (!requestOpen()) {
              <button type="button" class="rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="!canRequest()" (click)="openRequest()">Request payout</button>
            }
          </div>
          @if (summary()?.has_open_payout) {
            <p class="font-sans text-caption text-slate">You have a payout in progress — you can request again once it's settled.</p>
          } @else if (!account()) {
            <p class="font-sans text-caption text-slate">Add your payout account below before requesting a withdrawal.</p>
          }

          @if (requestOpen()) {
            <div class="flex flex-col gap-3 border-t border-cerulean/20 pt-4">
              <label class="flex max-w-xs flex-col gap-1.5">
                <span class="font-sans text-caption font-semibold text-slate">Amount ({{ currency() }})</span>
                <input inputmode="decimal" class="${FIELD}" [value]="amount()" (input)="amount.set($any($event.target).value)" placeholder="0.00" />
              </label>
              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-caption font-semibold text-slate">Note (optional)</span>
                <input class="${FIELD}" [value]="note()" (input)="note.set($any($event.target).value)" />
              </label>
              @if (requestError()) { <p class="font-sans text-caption text-alert">{{ requestError() }}</p> }
              <div class="flex items-center gap-3">
                <button type="button" class="rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="requesting()" (click)="submitRequest()">{{ requesting() ? 'Requesting…' : 'Submit request' }}</button>
                <button type="button" class="font-sans text-body-sm font-semibold text-slate transition-colors hover:text-ink" (click)="requestOpen.set(false)">Cancel</button>
              </div>
            </div>
          }
        </section>

        <!-- Payout account -->
        <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
          <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"><sd-icon name="banknote" [size]="20" />Payout account</h2>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label class="flex flex-col gap-1.5"><span class="font-sans text-caption font-semibold text-slate">Account holder</span><input class="${FIELD}" [value]="f().account_holder" (input)="setField('account_holder', $any($event.target).value)" /></label>
            <label class="flex flex-col gap-1.5"><span class="font-sans text-caption font-semibold text-slate">Bank name</span><input class="${FIELD}" [value]="f().bank_name" (input)="setField('bank_name', $any($event.target).value)" /></label>
            <label class="flex flex-col gap-1.5"><span class="font-sans text-caption font-semibold text-slate">Bank country</span><input class="${FIELD}" [value]="f().country" (input)="setField('country', $any($event.target).value)" placeholder="e.g. United Kingdom" /></label>
            <label class="flex flex-col gap-1.5"><span class="font-sans text-caption font-semibold text-slate">Payout currency</span><input class="${FIELD} uppercase" maxlength="3" [value]="f().currency" (input)="setField('currency', $any($event.target).value)" placeholder="USD" /></label>
            <label class="flex flex-col gap-1.5"><span class="font-sans text-caption font-semibold text-slate">IBAN</span><input class="${FIELD} uppercase" [value]="f().iban ?? ''" (input)="setField('iban', $any($event.target).value)" /></label>
            <label class="flex flex-col gap-1.5"><span class="font-sans text-caption font-semibold text-slate">Account number</span><input class="${FIELD}" [value]="f().account_number ?? ''" (input)="setField('account_number', $any($event.target).value)" /></label>
            <label class="flex flex-col gap-1.5"><span class="font-sans text-caption font-semibold text-slate">SWIFT / BIC</span><input class="${FIELD} uppercase" [value]="f().swift ?? ''" (input)="setField('swift', $any($event.target).value)" /></label>
            <label class="flex flex-col gap-1.5"><span class="font-sans text-caption font-semibold text-slate">Routing / sort code</span><input class="${FIELD}" [value]="f().routing_number ?? ''" (input)="setField('routing_number', $any($event.target).value)" /></label>
          </div>
          @if (accountNotice()) { <p class="rounded-field px-4 py-2 font-label text-caption" [class]="accountOk() ? 'bg-sage/10 text-sage' : 'bg-alert/10 text-alert'">{{ accountNotice() }}</p> }
          <button type="button" class="flex w-fit items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="savingAccount()" (click)="saveAccount()"><sd-icon name="check" [size]="18" />{{ savingAccount() ? 'Saving…' : 'Save account' }}</button>
        </section>

        <!-- History -->
        <section class="flex flex-col gap-3">
          <h2 class="font-heading text-body-lg text-ink">Payout history</h2>
          <div class="overflow-x-auto rounded-card border border-cloud bg-white">
            <table class="w-full min-w-[560px] text-left">
              <thead class="border-b border-cloud font-sans text-caption text-slate">
                <tr>
                  <th class="px-4 py-3">Requested</th>
                  <th class="px-4 py-3 text-right">Amount</th>
                  <th class="px-4 py-3">Status</th>
                  <th class="px-4 py-3">Reference</th>
                </tr>
              </thead>
              <tbody>
                @for (p of history(); track p.id) {
                  <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                    <td class="px-4 py-3 text-slate">{{ date(p.requested_at) }}</td>
                    <td class="px-4 py-3 text-right font-semibold">{{ money(p.amount) }}</td>
                    <td class="px-4 py-3"><span class="rounded-pill px-2.5 py-0.5 text-caption" [class]="statusClass(p.status)">{{ p.status }}</span></td>
                    <td class="px-4 py-3 text-slate">{{ p.reference || (p.admin_note || '—') }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="4" class="px-4 py-10 text-center font-sans text-body-sm text-slate">No payouts yet.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    </div>
  `,
})
export class DoctorPayouts implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly summary = signal<EarningsSummaryDto | null>(null);
  protected readonly account = signal<PayoutAccountDto | null>(null);
  protected readonly history = signal<PayoutDto[]>([]);

  protected readonly currency = computed(() => this.summary()?.currency ?? '₦');
  protected readonly available = computed(() => this.summary()?.available_balance ?? '0');
  protected readonly canRequest = computed(
    () => !!this.account() && !this.summary()?.has_open_payout && Number(this.available()) > 0,
  );

  // Request form
  protected readonly requestOpen = signal(false);
  protected readonly amount = signal('');
  protected readonly note = signal('');
  protected readonly requesting = signal(false);
  protected readonly requestError = signal('');

  // Account form
  protected readonly f = signal<PayoutAccountDto>({
    account_holder: '',
    bank_name: '',
    country: '',
    currency: 'USD',
    account_number: '',
    iban: '',
    swift: '',
    routing_number: '',
    updated_at: null,
  });
  protected readonly savingAccount = signal(false);
  protected readonly accountNotice = signal('');
  protected readonly accountOk = signal(false);

  ngOnInit(): void {
    this.reloadSummary();
    this.api.getPayoutAccount().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.account.set(res.data);
        if (res.data) this.f.set({ ...res.data });
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
    this.reloadHistory();
  }

  private reloadSummary(): void {
    this.api.earnings().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.summary.set(r.data), error: () => undefined });
  }
  private reloadHistory(): void {
    this.api.payouts().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.history.set(r.data), error: () => undefined });
  }

  protected setField(key: keyof PayoutAccountDto, value: string): void {
    this.f.update((v) => ({ ...v, [key]: key === 'currency' || key === 'iban' || key === 'swift' ? value.toUpperCase() : value }));
  }

  protected saveAccount(): void {
    this.savingAccount.set(true);
    this.accountNotice.set('');
    const v = this.f();
    this.api
      .savePayoutAccount({
        account_holder: v.account_holder,
        bank_name: v.bank_name,
        country: v.country,
        currency: v.currency,
        account_number: v.account_number || null,
        iban: v.iban || null,
        swift: v.swift || null,
        routing_number: v.routing_number || null,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.account.set(res.data);
          this.f.set({ ...res.data });
          this.accountOk.set(true);
          this.accountNotice.set('Payout account saved.');
          this.savingAccount.set(false);
        },
        error: (err) => {
          this.accountOk.set(false);
          this.accountNotice.set(apiErrorMessage(err, 'Could not save the account.'));
          this.savingAccount.set(false);
        },
      });
  }

  protected openRequest(): void {
    this.amount.set(this.available());
    this.note.set('');
    this.requestError.set('');
    this.requestOpen.set(true);
  }

  protected submitRequest(): void {
    const amt = this.amount().trim();
    if (!amt || Number(amt) <= 0) {
      this.requestError.set('Enter an amount greater than zero.');
      return;
    }
    this.requesting.set(true);
    this.requestError.set('');
    this.api
      .requestPayout(amt, this.note() || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.requesting.set(false);
          this.requestOpen.set(false);
          this.reloadSummary();
          this.reloadHistory();
        },
        error: (err) => {
          this.requestError.set(apiErrorMessage(err, 'Could not submit the request.'));
          this.requesting.set(false);
        },
      });
  }

  protected money(amount: string): string {
    const n = Number(amount);
    return this.currency() + (isNaN(n) ? '0.00' : n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }
  protected date(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }
  protected statusClass(status: string): string {
    return STATUS_CLASS[status] ?? 'bg-cloud text-slate';
  }
}
