import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type { PayoutStatus, SpecialistPayoutsDto } from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';
import { BTN_SECONDARY, CARD, dateOnly, money, PILL, plural } from '../specialist-ui';

const PAYOUT_STATUS: Record<PayoutStatus, { label: string; icon: string; cls: string }> = {
  pending: { label: 'Requested', icon: 'hourglass', cls: 'bg-warning/15 text-ink' },
  approved: { label: 'Approved', icon: 'check', cls: 'bg-frost text-cerulean' },
  paid: { label: 'Paid', icon: 'circle-check', cls: 'bg-sage/15 text-sage' },
  rejected: { label: 'Rejected', icon: 'circle-x', cls: 'bg-alert/10 text-alert' },
};

/**
 * The doctor page's Earnings & payouts tab: the earnings summary, the payout
 * account (account numbers masked by the API) and every payout request.
 * Payouts are settled on the Payouts page.
 */
@Component({
  selector: 'bo-specialist-earnings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, AlertComponent],
  template: `
    @if (loading()) {
      <div class="flex flex-col gap-4" aria-busy="true">
        <span class="sr-only" role="status">Loading earnings…</span>
        <div class="grid gap-3 sm:grid-cols-3"><div class="sd-shimmer h-24 rounded-card"></div><div class="sd-shimmer h-24 rounded-card"></div><div class="sd-shimmer h-24 rounded-card"></div></div>
        <div class="sd-shimmer h-48 rounded-card"></div>
      </div>
    } @else if (error()) {
      <div class="flex flex-col items-center gap-3 ${CARD} px-5 py-10 text-center">
        <sd-icon name="wifi-off" [size]="28" class="text-alert" />
        <p class="font-sans text-body-sm text-slate" role="alert">{{ error() }}</p>
        <button type="button" class="${BTN_SECONDARY}" (click)="load()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
      </div>
    } @else if (data(); as d) {
      <div class="flex flex-col gap-5">
        @if (suspended()) {
          <sd-alert tone="warning">While suspended the doctor can see their earnings but can't request new payouts. Requests already made can still be settled.</sd-alert>
        }

        <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Earnings summary">
          @for (t of tiles(); track t.label) {
            <div class="flex flex-col gap-1 ${CARD} p-4">
              <span class="font-sans text-caption font-semibold text-slate">{{ t.label }}</span>
              <span class="font-heading text-h5 text-ink">{{ t.value }}</span>
              @if (t.hint) { <span class="font-sans text-caption text-slate">{{ t.hint }}</span> }
            </div>
          }
        </section>

        <section class="flex flex-col gap-3 ${CARD} p-4 sm:p-6" aria-labelledby="bo-earn-acct-title">
          <h2 id="bo-earn-acct-title" class="font-heading text-body-lg font-semibold text-ink">Payout account</h2>
          @if (d.payout_account; as a) {
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 font-sans text-body-sm">
              <dt class="text-slate">Account holder</dt><dd class="break-words text-ink">{{ a.account_holder }}</dd>
              <dt class="text-slate">Bank</dt><dd class="break-words text-ink">{{ a.bank_name }}</dd>
              <dt class="text-slate">Country · currency</dt><dd class="text-ink">{{ a.country }} · {{ a.currency }}</dd>
              @if (a.account_number) { <dt class="text-slate">Account no.</dt><dd class="font-mono text-ink">{{ a.account_number }}</dd> }
              @if (a.iban) { <dt class="text-slate">IBAN</dt><dd class="break-all font-mono text-ink">{{ a.iban }}</dd> }
              @if (a.swift) { <dt class="text-slate">SWIFT</dt><dd class="font-mono text-ink">{{ a.swift }}</dd> }
              <dt class="text-slate">Updated</dt><dd class="text-ink">{{ day(a.updated_at) }}</dd>
            </dl>
            <p class="font-sans text-caption text-slate">Account numbers are masked. The full details are only used when a payout is paid.</p>
          } @else {
            <p class="font-sans text-body-sm text-slate">No payout account yet.</p>
          }
        </section>

        <section class="flex flex-col gap-3" aria-labelledby="bo-earn-payouts-title">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 id="bo-earn-payouts-title" class="font-heading text-body-lg font-semibold text-ink">Payouts</h2>
            @if (canSettle()) {
              <a routerLink="/payouts" class="inline-flex min-h-11 items-center gap-1 font-sans text-body-sm font-semibold text-cerulean hover:underline">Settle on the Payouts page<sd-icon name="chevron-right" [size]="16" /></a>
            }
          </div>
          <ul class="flex flex-col divide-y divide-cloud ${CARD}">
            @for (p of d.payouts; track p.id) {
              <li class="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="font-sans text-body-sm font-semibold text-ink">{{ money(p.amount, p.currency) }}</span>
                  <span class="font-sans text-caption text-slate">
                    Requested {{ day(p.requested_at) }}{{ p.paid_at ? ' · paid ' + day(p.paid_at) : (p.decided_at ? ' · decided ' + day(p.decided_at) : '') }}{{ p.reference ? ' · ref. ' + p.reference : '' }}
                  </span>
                  @if (p.admin_note) { <span class="break-words font-sans text-caption text-slate">Note: {{ p.admin_note }}</span> }
                </div>
                <span class="${PILL} w-fit" [class]="status(p.status).cls"><sd-icon [name]="status(p.status).icon" [size]="13" />{{ status(p.status).label }}</span>
              </li>
            } @empty {
              <li class="px-5 py-10 text-center font-sans text-body-sm text-slate">No payout requests yet.</li>
            }
          </ul>
        </section>
      </div>
    }
  `,
})
export class SpecialistEarningsTab implements OnInit {
  private readonly api = inject(SpecialistsApi);
  private readonly auth = inject(StaffAuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly specialistId = input.required<string>();
  readonly suspended = input(false);

  protected readonly data = signal<SpecialistPayoutsDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly canSettle = computed(() => this.auth.hasPermission('payouts.manage'));

  protected readonly tiles = computed(() => {
    const e = this.data()?.earnings;
    if (!e) return [];
    const c = e.currency;
    return [
      { label: 'Available to pay out', value: money(e.available_balance, c), hint: e.has_open_payout ? 'A payout request is open' : '' },
      { label: 'Earned this month (net)', value: money(e.net_month, c), hint: `Gross ${money(e.gross_month, c)}` },
      { label: 'Earned in total (net)', value: money(e.net_total, c), hint: `After ${e.commission_percent}% commission` },
      {
        label: 'Paid out',
        value: money(e.payouts_total, c),
        // A patient no-show earns the doctor the fee (less any refund), so it counts too.
        hint: `${plural(e.completed_count, 'completed consultation')}${e.patient_no_show_count ? ` + ${plural(e.patient_no_show_count, 'patient no-show')}` : ''}`,
      },
    ];
  });

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .doctorPayouts(this.specialistId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.error.set(apiErrorMessage(err, "Could not load this doctor's earnings."));
          this.loading.set(false);
        },
      });
  }

  protected status(s: PayoutStatus): { label: string; icon: string; cls: string } {
    return PAYOUT_STATUS[s] ?? { label: s, icon: 'info', cls: 'bg-cloud text-slate' };
  }
  protected money(amount: string, currency: string): string {
    return money(amount, currency);
  }
  protected day(iso: string | null): string {
    return dateOnly(iso);
  }
}
