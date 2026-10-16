import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { tap } from 'rxjs';
import { AdminPayoutsApi, apiErrorMessage } from '@supadoc/data-access';
import type { PayoutDto } from '@supadoc/models';
import type { ConfirmDetail } from '@supadoc/ui';
import { AlertComponent, DialogComponent, DialogService, EmptyStateComponent, IconComponent } from '@supadoc/ui';
import { afterDialogCloses } from '../shared/after-dialog';
import {
  AVATAR_SM,
  BTN_DANGER_OUTLINE,
  BTN_GHOST,
  BTN_SECONDARY,
  BTN_SUCCESS,
  EMPTY_FRAME,
  INLINE_ERROR,
  LOAD_MORE,
  PAGE,
  PAGE_HEADER_TEXT,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  PILL,
  SEGMENT,
  SEGMENT_OFF,
  SEGMENT_ON,
  SEGMENTED_WRAP,
  SEGMENT_FILL,
  TABLE,
  TABLE_LINK,
  TABLE_WRAP,
  TBODY,
  TD,
  TD_ACTION,
  TD_PRIMARY,
  TH,
  THEAD,
  TR,
} from '../shared/layout';
import { initials } from '../specialists/specialist-ui';

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

const STATUS: Record<string, { label: string; icon: string; cls: string }> = {
  pending: { label: 'Pending', icon: 'hourglass', cls: 'bg-warning/15 text-ink' },
  approved: { label: 'Approved', icon: 'circle-check', cls: 'bg-frost text-cerulean' },
  paid: { label: 'Paid', icon: 'landmark', cls: 'bg-sage/15 text-sage' },
  rejected: { label: 'Rejected', icon: 'ban', cls: 'bg-alert/10 text-alert' },
};

/**
 * Back-office payouts (route `/payouts`, needs payouts.manage). Approving,
 * marking paid (with the transfer reference) and rejecting (with the reason
 * the doctor is emailed) each ask first, showing the amount and the account.
 */
@Component({
  selector: 'bo-payouts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AlertComponent, DialogComponent, EmptyStateComponent],
  host: { class: 'block' },
  template: `
    <div class="${PAGE}">
      <header class="${PAGE_HEADER_TEXT}">
        <h1 class="${PAGE_TITLE}">Payouts</h1>
        <p class="${PAGE_SUBTITLE}">Review and settle doctor payout requests.</p>
      </header>

      <div class="${SEGMENTED_WRAP}" role="group" aria-label="Payout status">
        @for (f of filters; track f.key) {
          <button type="button" class="${SEGMENT} ${SEGMENT_FILL}" [class]="active() === f.key ? '${SEGMENT_ON}' : '${SEGMENT_OFF}'" [attr.aria-pressed]="active() === f.key" (click)="select(f)">{{ f.label }}</button>
        }
      </div>

      @if (items().length === 0) {
        @if (loading()) {
          <div class="${TABLE_WRAP} flex flex-col divide-y divide-cloud" aria-busy="true">
            <span class="sr-only">Loading payouts…</span>
            @for (i of [1, 2, 3]; track i) {
              <div class="flex items-center gap-4 px-5 py-4" aria-hidden="true">
                <div class="sd-shimmer size-10 shrink-0 rounded-full"></div>
                <div class="sd-shimmer h-4 w-40 max-w-full rounded-pill"></div>
                <div class="sd-shimmer ml-auto h-6 w-24 rounded-pill"></div>
              </div>
            }
          </div>
        } @else if (loadError()) {
          <div class="${EMPTY_FRAME}" role="alert">
            <sd-empty-state icon="wifi-off" tone="error" title="Couldn't load payouts" [message]="loadError()">
              <button type="button" class="${BTN_SECONDARY}" (click)="fetch()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
            </sd-empty-state>
          </div>
        } @else {
          <sd-empty-state icon="wallet" tone="brand" title="No payouts here" message="Payout requests doctors make show up here to review and settle." />
        }
      } @else {
        <div class="${TABLE_WRAP}">
          <table class="${TABLE} min-w-[720px]">
            <thead class="${THEAD}">
              <tr>
                <th class="${TH}">Doctor</th>
                <th class="${TH} text-right">Amount</th>
                <th class="${TH}">Status</th>
                <th class="${TH}">Requested</th>
                <th class="${TH}"><span class="sr-only">Review</span></th>
              </tr>
            </thead>
            <tbody class="${TBODY}">
              @for (p of items(); track p.id) {
                <tr class="${TR}">
                  <td class="${TD}">
                    <span class="flex min-w-0 items-center gap-3">
                      <span class="${AVATAR_SM}" aria-hidden="true">{{ initials(p.specialist_name) }}</span>
                      <span class="${TD_PRIMARY} min-w-0 truncate">{{ p.specialist_name }}</span>
                    </span>
                  </td>
                  <td class="${TD} text-right font-semibold">{{ money(p.amount, p.currency) }}</td>
                  <td class="${TD}"><span class="${PILL}" [class]="statusClass(p.status)"><sd-icon [name]="statusIcon(p.status)" [size]="13" />{{ statusLabel(p.status) }}</span></td>
                  <td class="${TD} text-slate">{{ date(p.requested_at) }}</td>
                  <td class="${TD_ACTION}"><button type="button" class="${TABLE_LINK}" [attr.aria-label]="'Review the payout of ' + p.specialist_name" (click)="open(p)">Review<sd-icon name="chevron-right" [size]="16" /></button></td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if ((loadError() && items().length > 0) || hasMore()) {
          <div class="${LOAD_MORE}">
            @if (loadError() && items().length > 0) {
              <p class="${INLINE_ERROR}" role="alert"><sd-icon name="circle-alert" [size]="16" class="shrink-0" />{{ loadError() }}</p>
            }
            @if (hasMore()) {
              <button type="button" class="${BTN_SECONDARY}" [disabled]="loading()" (click)="loadMore()">
                @if (loading()) {
                  <sd-icon name="loader-circle" [size]="16" class="animate-spin" />Loading…
                } @else {
                  <sd-icon name="chevron-down" [size]="16" />Load more
                }
              </button>
            }
          </div>
        }
      }
    </div>

    <sd-dialog
      [open]="dialogOpen()"
      [title]="dialogTitle()"
      [subtitle]="dialogSubtitle()"
      size="md"
      (closed)="close()"
      (afterClose)="current.set(null)"
    >
      @if (current(); as p) {
        <div class="flex flex-col gap-4">
          <div class="flex items-center justify-between gap-3 rounded-field bg-glacier px-4 py-3">
            <span class="font-heading text-h4 text-ink">{{ money(p.amount, p.currency) }}</span>
            <span class="${PILL}" [class]="statusClass(p.status)">
              <sd-icon [name]="statusIcon(p.status)" [size]="13" />{{ statusLabel(p.status) }}
            </span>
          </div>

          @if (p.note) {
            <p class="font-sans text-body-sm text-slate"><span class="font-semibold text-ink">Doctor's note:</span> {{ p.note }}</p>
          }

          @if (p.account; as acc) {
            <div class="flex flex-col gap-1.5 rounded-field border border-cloud p-4 font-sans text-body-sm">
              <span class="font-semibold text-slate">Beneficiary</span>
              <div class="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                <span class="text-slate">Holder: <span class="text-ink">{{ acc.account_holder }}</span></span>
                <span class="text-slate">Bank: <span class="text-ink">{{ acc.bank_name }}</span></span>
                <span class="text-slate">Country: <span class="text-ink">{{ acc.country }}</span></span>
                <span class="text-slate">Currency: <span class="text-ink">{{ acc.currency }}</span></span>
                @if (acc.iban) { <span class="break-all text-slate">IBAN: <span class="text-ink">{{ acc.iban }}</span></span> }
                @if (acc.account_number) { <span class="text-slate">Account #: <span class="text-ink">{{ acc.account_number }}</span></span> }
                @if (acc.swift) { <span class="text-slate">SWIFT: <span class="text-ink">{{ acc.swift }}</span></span> }
                @if (acc.routing_number) { <span class="text-slate">Routing: <span class="text-ink">{{ acc.routing_number }}</span></span> }
              </div>
            </div>
          } @else {
            <sd-alert tone="warning">No payout account was on file when this was requested.</sd-alert>
          }

          @if (p.status === 'paid' || p.status === 'rejected') {
            <p class="font-sans text-body-sm text-slate">
              {{ p.status === 'paid' ? 'Settled' : 'Rejected' }} by {{ p.decided_by || '—' }}{{ p.reference ? ' · ref ' + p.reference : '' }}{{ p.admin_note ? ' · ' + p.admin_note : '' }}.
            </p>
          } @else if (p.status === 'approved') {
            <p class="font-sans text-body-sm text-slate">
              Approved by {{ p.decided_by || '—' }}{{ p.admin_note ? ' · ' + p.admin_note : '' }}. Mark it paid once the transfer has gone out.
            </p>
          }

          <div aria-live="polite">
            @if (notice()) {
              <sd-alert tone="success">{{ notice() }}</sd-alert>
            }
          </div>
        </div>
      }
      <div dialogFooter class="flex flex-col-reverse gap-2 border-t border-cloud px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <button type="button" class="${BTN_GHOST}" data-autofocus (click)="close()">Close</button>
        @if (current(); as p) {
          @if (p.status === 'pending' || p.status === 'approved') {
            <button type="button" class="${BTN_DANGER_OUTLINE}" (click)="reject(p)"><sd-icon name="ban" [size]="18" />Reject</button>
            @if (p.status === 'pending') {
              <button type="button" class="${BTN_SECONDARY}" (click)="approve(p)"><sd-icon name="circle-check" [size]="18" />Approve</button>
            }
            <button type="button" class="${BTN_SUCCESS}" (click)="markPaid(p)"><sd-icon name="landmark" [size]="18" />Mark paid</button>
          }
        }
      </div>
    </sd-dialog>
  `,
})
export class AdminPayouts implements OnInit {
  private readonly api = inject(AdminPayoutsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly filters = FILTERS;
  protected readonly active = signal('pending');
  protected readonly items = signal<PayoutDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly hasMore = signal(false);
  private page = 1;

  private readonly dialogs = inject(DialogService);
  private readonly doc = inject(DOCUMENT);
  /** The review dialog, to put focus back in it after a decision removed the button that was used. */
  private readonly review = viewChild(DialogComponent);

  /** The review dialog is showing. */
  protected readonly dialogOpen = signal(false);
  /** The payout in the dialog (kept while it animates out). */
  protected readonly current = signal<PayoutDto | null>(null);
  /** What the last decision did (inside the dialog). */
  protected readonly notice = signal('');
  protected readonly dialogTitle = computed(() => {
    const p = this.current();
    return p ? `Payout — ${p.specialist_name}` : 'Payout';
  });
  protected readonly dialogSubtitle = computed(() => {
    const p = this.current();
    return p ? `Requested ${this.date(p.requested_at)}` : '';
  });

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

  /** The doctor's initials for the row avatar. */
  protected readonly initials = initials;

  protected loadMore(): void {
    if (this.loading()) return;
    this.page += 1;
    this.fetch();
  }

  protected fetch(): void {
    this.loading.set(true);
    this.loadError.set('');
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
        error: (err: unknown) => {
          if (this.page > 1) this.page -= 1;
          this.loadError.set(apiErrorMessage(err, 'Could not load payouts.'));
          this.loading.set(false);
        },
      });
  }

  protected open(p: PayoutDto): void {
    this.current.set(p);
    this.notice.set('');
    this.dialogOpen.set(true);
  }
  protected close(): void {
    this.dialogOpen.set(false);
  }

  protected async approve(p: PayoutDto): Promise<void> {
    const amount = this.money(p.amount, p.currency);
    await this.dialogs.confirm({
      tone: 'info',
      icon: 'circle-check',
      title: `Approve ${amount} for ${p.specialist_name}?`,
      message: "They're told it's approved and on its way. Mark it paid once the transfer has gone out.",
      details: this.details(p),
      reason: { label: 'Note for the doctor', maxLength: 500, hint: 'Included in the email to the doctor.' },
      confirmLabel: 'Approve payout',
      cancelLabel: 'Not now',
      size: 'md',
      busyLabel: 'Approving…',
      action: (note) => this.api.approve(p.id, note).pipe(tap((res) => this.applied(res.data, 'Approved. The doctor has been told.'))),
    });
  }

  protected async markPaid(p: PayoutDto): Promise<void> {
    const amount = this.money(p.amount, p.currency);
    await this.dialogs.confirm({
      tone: 'warning',
      icon: 'landmark',
      title: `Mark ${amount} as paid to ${this.accountLabel(p)}?`,
      message: "Only after the transfer has gone out — this can't be undone. The doctor is emailed the reference.",
      details: this.details(p),
      reason: { label: 'Payment reference', placeholder: 'e.g. the bank transfer ID', required: true, maxLength: 120 },
      confirmLabel: 'Mark as paid',
      cancelLabel: 'Not yet',
      size: 'md',
      busyLabel: 'Saving…',
      action: (reference) => this.api.markPaid(p.id, reference).pipe(tap((res) => this.applied(res.data, 'Marked paid. The doctor has been emailed the reference.'))),
    });
  }

  protected async reject(p: PayoutDto): Promise<void> {
    const amount = this.money(p.amount, p.currency);
    await this.dialogs.confirm({
      tone: 'danger',
      icon: 'ban',
      title: `Reject ${p.specialist_name}'s ${amount} payout?`,
      message: "They're emailed your reason and can request again.",
      details: this.details(p),
      reason: { label: 'Reason for rejecting', placeholder: 'e.g. The account name does not match the doctor.', required: true, minLength: 3, maxLength: 500, hint: 'Sent to the doctor.' },
      confirmLabel: 'Reject payout',
      cancelLabel: 'Keep it',
      size: 'md',
      busyLabel: 'Rejecting…',
      action: (reason) => this.api.reject(p.id, reason).pipe(tap((res) => this.applied(res.data, 'Rejected. The doctor has been emailed your reason.'))),
    });
  }

  private applied(next: PayoutDto, message: string): void {
    this.items.update((list) => list.map((x) => (x.id === next.id ? next : x)));
    if (this.current()?.id === next.id) {
      this.current.set(next);
      this.notice.set(message);
      // The confirmation's opener (Approve, Reject, Mark paid) is gone or moved:
      // once it has closed, focus the review dialog's Close button rather than
      // leave it on the page body.
      afterDialogCloses(() => {
        if (this.dialogOpen()) this.review()?.refocus();
      }, this.doc);
    }
  }

  /** What to check before deciding: amount, doctor, where the money goes. */
  private details(p: PayoutDto): ConfirmDetail[] {
    const out: ConfirmDetail[] = [
      { label: 'Amount', value: this.money(p.amount, p.currency) },
      { label: 'Doctor', value: p.specialist_name },
    ];
    if (p.account) {
      out.push({ label: 'Account', value: this.accountLabel(p) });
      out.push({ label: 'Holder', value: p.account.account_holder });
    }
    out.push({ label: 'Requested', value: this.date(p.requested_at) });
    return out;
  }

  /** "GTBank ••1234" (the last four of the account number or IBAN). */
  private accountLabel(p: PayoutDto): string {
    const acc = p.account;
    if (!acc) return 'their account';
    const digits = (acc.account_number || acc.iban || '').replace(/\s+/g, '');
    return digits ? `${acc.bank_name} ••${digits.slice(-4)}` : acc.bank_name;
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
    return STATUS[status]?.cls ?? 'bg-cloud text-slate';
  }
  protected statusLabel(status: string): string {
    return STATUS[status]?.label ?? status;
  }
  protected statusIcon(status: string): string {
    return STATUS[status]?.icon ?? 'circle-help';
  }
}
