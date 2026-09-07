import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Observable } from 'rxjs';
import { AdminPayoutsApi, apiErrorMessage } from '@supadoc/data-access';
import type { PayoutDto, SuccessResponse } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

interface Filter {
  readonly key: string;
  readonly label: string;
  readonly status: string;
}

const FILTERS: Filter[] = [
  { key: 'pending', label: 'Pending', status: 'pending' },
  { key: 'approved', label: 'Approved', status: 'approved' },
  { key: 'paid', label: 'Paid', status: 'paid' },
  { key: 'rejected', label: 'Rejected', status: 'rejected' },
  { key: 'all', label: 'All', status: '' },
];

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  approved: 'bg-frost text-cerulean',
  paid: 'bg-sage/15 text-sage',
  rejected: 'bg-alert/10 text-alert',
};

/** Back-office payouts (route `/payouts`, needs payouts.manage). */
@Component({
  selector: 'bo-payouts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Payouts</h1>
        <p class="font-sans text-body text-slate">Review and settle doctor payout requests.</p>
      </header>

      <div class="flex flex-wrap gap-2">
        @for (f of filters; track f.key) {
          <button type="button" class="rounded-field px-4 py-2 font-sans text-body-sm font-semibold transition-colors" [class]="active() === f.key ? 'bg-cerulean/10 text-cerulean' : 'text-slate hover:bg-frost/40'" (click)="select(f)">{{ f.label }}</button>
        }
      </div>

      <div class="overflow-x-auto rounded-card border border-cloud bg-white">
        <table class="w-full min-w-[720px] text-left">
          <thead class="border-b border-cloud font-sans text-caption text-slate">
            <tr>
              <th class="px-4 py-3">Doctor</th>
              <th class="px-4 py-3 text-right">Amount</th>
              <th class="px-4 py-3">Status</th>
              <th class="px-4 py-3">Requested</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            @for (p of items(); track p.id) {
              <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                <td class="px-4 py-3 font-medium">{{ p.specialist_name }}</td>
                <td class="px-4 py-3 text-right font-semibold">{{ money(p.amount, p.currency) }}</td>
                <td class="px-4 py-3"><span class="rounded-pill px-2.5 py-0.5 text-caption" [class]="statusClass(p.status)">{{ p.status }}</span></td>
                <td class="px-4 py-3 text-slate">{{ date(p.requested_at) }}</td>
                <td class="px-4 py-3 text-right"><button type="button" class="font-sans text-caption font-semibold text-cerulean hover:underline" (click)="open(p)">Review</button></td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="px-4 py-10 text-center font-sans text-body-sm text-slate">{{ loading() ? 'Loading…' : 'No payouts.' }}</td></tr>
            }
          </tbody>
        </table>
      </div>

      @if (hasMore()) {
        <button type="button" class="mx-auto rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="loading()" (click)="loadMore()">{{ loading() ? 'Loading…' : 'Load more' }}</button>
      }
    </div>

    @if (selected(); as p) {
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="close()"></button>
        <div class="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-[16px] border border-cloud bg-white p-6 shadow-[0_4px_24px_rgba(10,22,40,0.12)]">
          <div class="flex items-center justify-between">
            <h2 class="font-heading text-h5 text-ink">Payout — {{ p.specialist_name }}</h2>
            <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="close()"><sd-icon name="x" [size]="24" /></button>
          </div>

          <div class="flex items-center justify-between rounded-field bg-glacier px-4 py-3">
            <span class="font-heading text-h4 text-ink">{{ money(p.amount, p.currency) }}</span>
            <span class="rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold" [class]="statusClass(p.status)">{{ p.status }}</span>
          </div>

          @if (p.note) { <p class="font-sans text-body-sm text-slate"><span class="font-semibold text-ink">Doctor's note:</span> {{ p.note }}</p> }

          @if (p.account; as acc) {
            <div class="flex flex-col gap-1.5 rounded-field border border-cloud p-4 font-sans text-body-sm">
              <span class="font-semibold text-slate">Beneficiary</span>
              <div class="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                <span class="text-slate">Holder: <span class="text-ink">{{ acc.account_holder }}</span></span>
                <span class="text-slate">Bank: <span class="text-ink">{{ acc.bank_name }}</span></span>
                <span class="text-slate">Country: <span class="text-ink">{{ acc.country }}</span></span>
                <span class="text-slate">Currency: <span class="text-ink">{{ acc.currency }}</span></span>
                @if (acc.iban) { <span class="text-slate">IBAN: <span class="text-ink">{{ acc.iban }}</span></span> }
                @if (acc.account_number) { <span class="text-slate">Account #: <span class="text-ink">{{ acc.account_number }}</span></span> }
                @if (acc.swift) { <span class="text-slate">SWIFT: <span class="text-ink">{{ acc.swift }}</span></span> }
                @if (acc.routing_number) { <span class="text-slate">Routing: <span class="text-ink">{{ acc.routing_number }}</span></span> }
              </div>
            </div>
          }

          @if (p.status === 'pending' || p.status === 'approved') {
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Note / payment reference (optional)</span>
              <input class="w-full rounded-field border border-cloud bg-white px-4 py-2.5 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" [value]="noteInput()" (input)="noteInput.set($any($event.target).value)" />
            </label>
            @if (actionError()) { <p class="font-sans text-caption text-alert">{{ actionError() }}</p> }
            <div class="flex flex-wrap gap-2">
              @if (p.status === 'pending') {
                <button type="button" class="rounded-field bg-cerulean px-4 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="busy()" (click)="approve(p)">Approve</button>
              }
              <button type="button" class="rounded-field bg-sage px-4 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-60" [disabled]="busy()" (click)="markPaid(p)">Mark paid</button>
              <button type="button" class="rounded-field border border-alert px-4 py-2.5 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5 disabled:opacity-60" [disabled]="busy()" (click)="reject(p)">Reject</button>
            </div>
          } @else {
            <p class="font-sans text-body-sm text-slate">
              {{ p.status === 'paid' ? 'Settled' : 'Rejected' }} by {{ p.decided_by || '—' }}{{ p.reference ? ' · ref ' + p.reference : '' }}{{ p.admin_note ? ' · ' + p.admin_note : '' }}.
            </p>
          }
        </div>
      </div>
    }
  `,
})
export class AdminPayouts implements OnInit {
  private readonly api = inject(AdminPayoutsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly filters = FILTERS;
  protected readonly active = signal('pending');
  protected readonly items = signal<PayoutDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);
  private page = 1;

  protected readonly selected = signal<PayoutDto | null>(null);
  protected readonly noteInput = signal('');
  protected readonly busy = signal(false);
  protected readonly actionError = signal('');

  ngOnInit(): void {
    this.fetch();
  }

  protected select(f: Filter): void {
    if (this.active() === f.key) return;
    this.active.set(f.key);
    this.page = 1;
    this.items.set([]);
    this.fetch();
  }

  protected loadMore(): void {
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    const status = this.filters.find((f) => f.key === this.active())?.status || undefined;
    this.api
      .list({ page: this.page, per_page: 20, status })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  protected open(p: PayoutDto): void {
    this.selected.set(p);
    this.noteInput.set('');
    this.actionError.set('');
  }
  protected close(): void {
    this.selected.set(null);
  }

  protected approve(p: PayoutDto): void {
    this.run(this.api.approve(p.id, this.noteInput() || undefined));
  }
  protected markPaid(p: PayoutDto): void {
    this.run(this.api.markPaid(p.id, this.noteInput() || undefined));
  }
  protected reject(p: PayoutDto): void {
    if (!window.confirm('Reject this payout request?')) return;
    this.run(this.api.reject(p.id, this.noteInput() || undefined));
  }

  private run(call: Observable<SuccessResponse<PayoutDto>>): void {
    this.busy.set(true);
    this.actionError.set('');
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.items.update((list) => list.map((x) => (x.id === res.data.id ? res.data : x)));
        this.selected.set(res.data);
        this.busy.set(false);
      },
      error: (err) => {
        this.actionError.set(apiErrorMessage(err, 'Could not update the payout.'));
        this.busy.set(false);
      },
    });
  }

  protected money(amount: string, currency: string): string {
    const n = Number(amount);
    const sym = currency === 'NGN' ? '₦' : currency + ' ';
    return sym + (isNaN(n) ? '0.00' : n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }
  protected date(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
  protected statusClass(status: string): string {
    return STATUS_CLASS[status] ?? 'bg-cloud text-slate';
  }
}
