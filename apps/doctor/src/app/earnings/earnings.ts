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
import { RouterLink } from '@angular/router';
import { DoctorApi } from '@supadoc/data-access';
import type { EarningsSummaryDto, EarningsTxnDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

/** Doctor earnings (route `/earnings`) — summary + per-consultation ledger. */
@Component({
  selector: 'doc-earnings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Earnings</h1>
          <p class="font-sans text-body text-slate">What you've earned and can withdraw.</p>
        </div>
        <a routerLink="/payouts" class="flex shrink-0 items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean">
          <sd-icon name="banknote" [size]="18" />Payouts
        </a>
      </header>

      @if (loading()) {
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          @for (i of [1,2,3,4]; track i) { <div class="sd-shimmer h-28 rounded-card"></div> }
        </div>
      } @else if (summary(); as s) {
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div class="rounded-card border border-cerulean/30 bg-frost/20 p-5">
            <p class="font-sans text-caption text-slate">Available to withdraw</p>
            <p class="mt-1 font-heading text-h3 text-cerulean">{{ money(s.available_balance) }}</p>
          </div>
          <div class="rounded-card border border-cloud bg-white p-5">
            <p class="font-sans text-caption text-slate">Net earned (all time)</p>
            <p class="mt-1 font-heading text-h4 text-ink">{{ money(s.net_total) }}</p>
          </div>
          <div class="rounded-card border border-cloud bg-white p-5">
            <p class="font-sans text-caption text-slate">This month (net)</p>
            <p class="mt-1 font-heading text-h4 text-ink">{{ money(s.net_month) }}</p>
          </div>
          <div class="rounded-card border border-cloud bg-white p-5">
            <p class="font-sans text-caption text-slate">Consultations</p>
            <p class="mt-1 font-heading text-h4 text-ink">{{ s.completed_count }}</p>
          </div>
        </div>

        <div class="flex flex-wrap gap-6 rounded-card border border-cloud bg-white px-6 py-4 font-sans text-body-sm">
          <span class="text-slate">Gross earned: <span class="font-semibold text-ink">{{ money(s.gross_total) }}</span></span>
          <span class="text-slate">Platform commission ({{ s.commission_percent }}%): <span class="font-semibold text-ink">{{ money(s.commission_total) }}</span></span>
          <span class="text-slate">Paid/requested: <span class="font-semibold text-ink">{{ money(s.payouts_total) }}</span></span>
        </div>

        <section class="flex flex-col gap-3">
          <h2 class="font-heading text-body-lg text-ink">Consultation earnings</h2>
          <div class="overflow-x-auto rounded-card border border-cloud bg-white">
            <table class="w-full min-w-[640px] text-left">
              <thead class="border-b border-cloud font-sans text-caption text-slate">
                <tr>
                  <th class="px-4 py-3">Date</th>
                  <th class="px-4 py-3">Patient</th>
                  <th class="px-4 py-3 text-right">Gross</th>
                  <th class="px-4 py-3 text-right">Commission</th>
                  <th class="px-4 py-3 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                @for (t of txns(); track t.appointment_id) {
                  <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                    <td class="px-4 py-3 text-slate">{{ date(t.date) }}</td>
                    <td class="px-4 py-3">{{ t.patient_name }}</td>
                    <td class="px-4 py-3 text-right text-slate">{{ money(t.gross) }}</td>
                    <td class="px-4 py-3 text-right text-slate">−{{ money(t.commission) }}</td>
                    <td class="px-4 py-3 text-right font-semibold">{{ money(t.net) }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="px-4 py-10 text-center font-sans text-body-sm text-slate">{{ loadingTxns() ? 'Loading…' : 'No completed consultations yet.' }}</td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (hasMore()) {
            <button type="button" class="mx-auto rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="loadingTxns()" (click)="loadMore()">
              {{ loadingTxns() ? 'Loading…' : 'Load more' }}
            </button>
          }
        </section>
      }
    </div>
  `,
})
export class DoctorEarnings implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly summary = signal<EarningsSummaryDto | null>(null);
  protected readonly txns = signal<EarningsTxnDto[]>([]);
  protected readonly loadingTxns = signal(true);
  protected readonly hasMore = signal(false);
  private page = 1;

  protected readonly currency = computed(() => this.summary()?.currency ?? '₦');

  ngOnInit(): void {
    this.api
      .earnings()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.summary.set(res.data);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
    this.fetchTxns();
  }

  protected loadMore(): void {
    this.page += 1;
    this.fetchTxns();
  }

  private fetchTxns(): void {
    this.loadingTxns.set(true);
    this.api
      .earningsTransactions({ page: this.page, per_page: 20 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.txns.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loadingTxns.set(false);
        },
        error: () => this.loadingTxns.set(false),
      });
  }

  protected money(amount: string): string {
    const n = Number(amount);
    return this.currency() + (isNaN(n) ? '0.00' : n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }
  protected date(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }
}
