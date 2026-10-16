import { NgTemplateOutlet } from '@angular/common';
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
import { ActivatedRoute, Params, Router, RouterLink } from '@angular/router';
import type { Subscription } from 'rxjs';
import { AdminAppointmentsApi, apiErrorMessage } from '@supadoc/data-access';
import { StaffAuthService } from '@supadoc/auth';
import type { AppointmentDto, AppointmentWhen } from '@supadoc/models';
import { EmptyStateComponent, IconComponent } from '@supadoc/ui';
import {
  appointmentBadge,
  AppointmentBadge,
  appointmentWhen,
  ATTENTION_BADGE,
  hasRefund,
  naira,
} from '../shared/appointment-status';
import { initials } from '../dashboard/dashboard-ui';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  COUNT_BADGE,
  EMPTY_FRAME,
  FILTER_CHIP,
  FILTER_CHIP_OFF,
  FILTER_CHIP_ON,
  FILTER_CHIPS,
  FOCUS_RING,
  INLINE_ERROR,
  LOAD_MORE,
  LOAD_MORE_NOTE,
  PAGE,
  PAGE_HEADER,
  PAGE_HEADER_TEXT,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  PAGE_TITLE_ROW,
  PERSON_CHIP,
  PERSON_CHIP_AVATAR,
  PERSON_CHIP_NAME,
  PILL,
  ROW_ACTION_LAYER,
  ROW_CHEVRON_ICON,
  ROW_CUE,
  SEGMENT,
  SEGMENT_FILL,
  SEGMENT_OFF,
  SEGMENT_ON,
  SEGMENTED_WRAP,
  TABLE,
  TABLE_ROW_LINK,
  TABLE_WRAP,
  TBODY,
  TD,
  TD_AMOUNT,
  TD_CUE,
  TD_PRIMARY,
  TD_SUB,
  TH,
  THEAD,
  TR,
  TR_LINKED,
} from '../shared/layout';

type WhenKey = 'all' | AppointmentWhen;

interface WhenFilter {
  readonly key: WhenKey;
  readonly label: string;
}

interface StatusFilter {
  readonly key: string;
  readonly label: string;
}

/** By time: upcoming soonest first, past and "needs attention" newest first (the API fixes the order). */
const WHEN_FILTERS: readonly WhenFilter[] = [
  { key: 'all', label: 'All' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'past', label: 'Past' },
  // Past and still open (pending / confirmed / rescheduled after it ended).
  { key: 'attention', label: 'Needs attention' },
];

const STATUS_FILTERS: readonly StatusFilter[] = [
  { key: '', label: 'Any status' },
  // Follow-ups a doctor proposed that the patient hasn't answered yet.
  { key: 'proposed', label: 'Proposed' },
  { key: 'pending', label: 'Pending' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'rescheduled', label: 'Rescheduled' },
  { key: 'completed', label: 'Completed' },
  { key: 'missed', label: 'Missed' },
  { key: 'cancelled', label: 'Cancelled' },
];

const OPEN = ['pending', 'confirmed', 'rescheduled'];
const CLOSED = ['completed', 'missed', 'cancelled'];

const PAYMENT_LABEL: Record<string, string> = {
  unpaid: 'Not paid',
  pending: 'Payment pending',
  paid: 'Paid',
  refunded: 'Refunded',
};

interface Row {
  readonly a: AppointmentDto;
  readonly badge: AppointmentBadge;
  readonly when: string;
  readonly payment: string;
}

/**
 * Appointments management (route `/appointments`): every consultation, split
 * by time (upcoming / past / needs attention — past and still open) and by
 * status, with the server's display label ("Missed", "Not confirmed", "Being
 * finalised"…) and its detail ("Doctor didn't attend"). The filters live in
 * the URL (`?when=attention&status=missed`) so they survive Back and can be
 * linked to.
 */
@Component({
  selector: 'bo-appointments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, EmptyStateComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="${PAGE}">
      <header class="${PAGE_HEADER}">
        <div class="${PAGE_HEADER_TEXT}">
          <div class="${PAGE_TITLE_ROW}">
            <h1 class="${PAGE_TITLE}">Appointments</h1>
            @if (allTotal(); as n) {
              <span class="${COUNT_BADGE}"><sd-icon name="calendar-days" [size]="14" />{{ countLabel(n) }}</span>
            }
          </div>
          <p class="${PAGE_SUBTITLE}">Every consultation across the platform.</p>
        </div>
        @if (canCreate()) {
          <a routerLink="/appointments/new" class="${BTN_PRIMARY} shrink-0">
            <sd-icon name="plus" [size]="18" />New appointment
          </a>
        }
      </header>

      <div class="flex flex-col gap-4">
        <div class="${SEGMENTED_WRAP}" role="group" aria-label="When">
          @for (f of whenFilters; track f.key) {
            <button
              type="button"
              class="${SEGMENT} ${SEGMENT_FILL}"
              [class]="when() === f.key ? '${SEGMENT_ON}' : '${SEGMENT_OFF}'"
              [attr.aria-pressed]="when() === f.key"
              (click)="setWhen(f.key)"
            >
              @if (f.key === 'attention') {
                <sd-icon name="triangle-alert" [size]="16" [class]="attentionCount() ? 'text-warning' : ''" />
              }
              {{ f.label }}
              @if (f.key === 'attention' && attentionCount(); as n) {
                <span class="flex min-w-5 items-center justify-center rounded-full bg-warning/25 px-1.5 text-[11px] font-semibold text-ink">{{ n }}<span class="sr-only"> waiting</span></span>
              }
            </button>
          }
        </div>
        <div class="${FILTER_CHIPS}" role="group" aria-label="Status">
          @for (f of statusFilters(); track f.key) {
            <button
              type="button"
              class="${FILTER_CHIP}"
              [class]="status() === f.key ? '${FILTER_CHIP_ON}' : '${FILTER_CHIP_OFF}'"
              [attr.aria-pressed]="status() === f.key"
              (click)="setStatus(f.key)"
            >
              @if (status() === f.key) { <sd-icon name="check" [size]="14" /> }{{ f.label }}
            </button>
          }
        </div>
        @if (when() === 'attention') {
          <p class="flex items-start gap-2 font-sans text-body-sm text-slate">
            <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0" />
            Consultations that ended but are still pending, confirmed or rescheduled. The automatic check closes them, unless both sides joined but nothing proves it took place; those wait for staff. Open one to settle it sooner.
          </p>
        }
      </div>

      <p class="sr-only" aria-live="polite">{{ loading() ? 'Loading appointments' : total() + ' appointments' }}</p>

      @if (rows().length === 0) {
        @if (loading()) {
          <div class="${TABLE_WRAP} flex flex-col divide-y divide-cloud" aria-busy="true">
            <span class="sr-only">Loading appointments…</span>
            @for (i of [1, 2, 3, 4]; track i) {
              <div class="flex items-center gap-4 px-5 py-4" aria-hidden="true">
                <div class="flex min-w-0 flex-1 flex-col gap-2">
                  <div class="sd-shimmer h-4 w-40 max-w-full rounded-pill"></div>
                  <div class="sd-shimmer h-3 w-56 max-w-full rounded-pill"></div>
                </div>
                <div class="sd-shimmer hidden h-4 w-28 rounded-pill sm:block"></div>
                <div class="sd-shimmer h-6 w-24 rounded-pill"></div>
              </div>
            }
          </div>
        } @else if (loadError()) {
          <div class="${EMPTY_FRAME}">
            <sd-empty-state icon="wifi-off" tone="error" title="Couldn't load appointments" [message]="loadError()">
              <button type="button" class="${BTN_SECONDARY}" (click)="reload()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
            </sd-empty-state>
          </div>
        } @else if (when() === 'attention') {
          <sd-empty-state icon="circle-check" tone="brand" title="Nothing needs attention" message="Every consultation that has ended is closed." />
        } @else {
          <sd-empty-state icon="calendar-days" title="No appointments" [message]="emptyText()" />
        }
      } @else {
        <!-- Phones: one card per consultation -->
        <ul class="flex flex-col gap-3 md:hidden">
          @for (r of rows(); track r.a.id) {
            <li>
              <a
                [routerLink]="['/appointments', r.a.id]"
                [state]="{ listQuery: queryParams() }"
                class="flex flex-col gap-2 rounded-card border bg-white p-5 shadow-card transition hover:border-cerulean/40 hover:shadow-card-hover ${FOCUS_RING}"
                [class]="r.a.needs_attention ? 'border-warning' : 'border-haze'"
              >
                <div class="flex items-start justify-between gap-3">
                  <span class="flex min-w-0 flex-col">
                    <span class="truncate font-heading text-body-lg text-ink">{{ r.a.patient?.name || 'Patient' }}</span>
                    <span class="truncate font-sans text-body-sm text-slate">with {{ r.a.specialist.name }}</span>
                  </span>
                  <span class="shrink-0 text-right font-sans text-body-sm font-semibold text-ink">{{ money(r.a.amount) }}</span>
                </div>
                <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="calendar-days" [size]="16" class="shrink-0 text-slate" />{{ r.when }} · {{ r.a.type_label }}</span>
                <div class="flex flex-wrap items-center gap-1.5">
                  <ng-container [ngTemplateOutlet]="badgeTpl" [ngTemplateOutletContext]="{ $implicit: r }" />
                  <span class="font-sans text-caption text-slate">{{ r.payment }}</span>
                </div>
                @if (r.badge.detail) {
                  <span class="font-sans text-caption text-slate">{{ r.badge.detail }}</span>
                }
              </a>
            </li>
          }
        </ul>

        <!-- Tablets and up: a table -->
        <div class="hidden ${TABLE_WRAP} md:block">
          <table class="${TABLE} min-w-[760px]">
            <thead class="${THEAD}">
              <tr>
                <th class="${TH}">Patient</th>
                <th class="${TH}">Specialist</th>
                <th class="${TH}">When</th>
                <th class="${TH}">Amount</th>
                <th class="${TH}">Status</th>
                <th class="${TH} w-px" aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody class="${TBODY}">
              @for (r of rows(); track r.a.id) {
                <!-- The whole row is the patient-name link (its ::after covers the row). -->
                <tr class="${TR} ${TR_LINKED}" [class]="r.a.needs_attention ? 'bg-warning/5' : ''">
                  <td class="${TD}">
                    <a
                      [routerLink]="['/appointments', r.a.id]"
                      [state]="{ listQuery: queryParams() }"
                      class="${TABLE_ROW_LINK}"
                      [attr.aria-label]="(r.a.needs_attention ? 'Resolve' : 'Open') + ' the appointment of ' + (r.a.patient?.name || 'the patient') + ' with ' + r.a.specialist.name"
                    >{{ r.a.patient?.name || '—' }}</a>
                    <span class="${TD_SUB}">{{ r.a.patient?.email }}</span>
                  </td>
                  <td class="${TD}">
                    <span class="${TD_PRIMARY} xl:hidden">{{ r.a.specialist.name }}</span>
                    <span class="hidden xl:contents"><span class="${PERSON_CHIP}"><span class="${PERSON_CHIP_AVATAR}" aria-hidden="true">{{ initials(r.a.specialist.name) }}</span><span class="${PERSON_CHIP_NAME}">{{ r.a.specialist.name }}</span></span></span>
                    <span class="${TD_SUB}">{{ r.a.specialist.specialty }}</span>
                  </td>
                  <td class="${TD}">
                    {{ r.when }}
                    <span class="${TD_SUB}">
                      {{ r.a.type_label }}
                      @if (r.a.parent_appointment_id) {
                        · <a [routerLink]="['/appointments', r.a.parent_appointment_id]" class="${ROW_ACTION_LAYER} rounded-field font-semibold text-cerulean hover:underline ${FOCUS_RING}">follow-up of {{ r.a.parent ? day(r.a.parent.scheduled_at) : 'an earlier visit' }}</a>
                      }
                    </span>
                  </td>
                  <td class="${TD}">
                    <span class="${TD_AMOUNT}">{{ money(r.a.amount) }}</span>
                    <span class="${TD_SUB}">{{ r.payment }}</span>
                  </td>
                  <td class="${TD}">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <ng-container [ngTemplateOutlet]="badgeTpl" [ngTemplateOutletContext]="{ $implicit: r }" />
                    </div>
                    @if (r.badge.detail) {
                      <span class="mt-1 ${TD_SUB}">{{ r.badge.detail }}</span>
                    }
                  </td>
                  <td class="${TD_CUE}" aria-hidden="true">
                    <span class="${ROW_CUE}">
                      @if (r.a.needs_attention) { Resolve }
                      <sd-icon name="chevron-right" [size]="20" class="${ROW_CHEVRON_ICON}" />
                    </span>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }

      <ng-template #badgeTpl let-r>
        <span class="${PILL}" [class]="r.badge.cls">
          @if (r.badge.live) {
            <span class="size-2 rounded-full bg-current motion-safe:animate-pulse" aria-hidden="true"></span>
          } @else {
            <sd-icon [name]="r.badge.icon" [size]="13" />
          }
          {{ r.badge.label }}
        </span>
        @if (r.a.needs_attention) {
          <span class="${PILL} ${ATTENTION_BADGE.cls}"><sd-icon name="${ATTENTION_BADGE.icon}" [size]="13" />{{ attention.label }}</span>
        }
      </ng-template>

      @if ((loadError() && rows().length > 0) || hasMore()) {
        <div class="${LOAD_MORE}">
          @if (loadError() && rows().length > 0) {
            <p class="${INLINE_ERROR}" role="alert"><sd-icon name="circle-alert" [size]="16" class="shrink-0" />{{ loadError() }}</p>
          }
          @if (hasMore()) {
            <p class="${LOAD_MORE_NOTE}">Showing {{ formatCount(rows().length) }} of {{ formatCount(total()) }}</p>
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
    </div>
  `,
})
export class AdminAppointments implements OnInit {
  private readonly api = inject(AdminAppointmentsApi);
  private readonly auth = inject(StaffAuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly canCreate = computed(() => this.auth.hasPermission('appointments.create'));
  protected readonly whenFilters = WHEN_FILTERS;
  protected readonly attention = ATTENTION_BADGE;
  /** The Specialist column's chip avatar (no photo on the ref: initials, "Dr." stripped). */
  protected readonly initials = initials;
  protected readonly when = signal<WhenKey>('all');
  protected readonly status = signal('');
  protected readonly items = signal<AppointmentDto[]>([]);
  protected readonly total = signal(0);
  /** `meta.total` of the last unfiltered load (All, any status) — the header's count. */
  protected readonly allTotal = signal<number | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly hasMore = signal(false);
  /** Past consultations still open — shown on the "Needs attention" filter. */
  protected readonly attentionCount = signal(0);
  private page = 1;
  private sub?: Subscription;

  /** Only the statuses a time filter can hold (upcoming: open ones; needs attention: pending / confirmed / rescheduled). */
  protected readonly statusFilters = computed(() => {
    const when = this.when();
    if (when === 'attention') return STATUS_FILTERS.filter((f) => f.key === '' || OPEN.includes(f.key));
    if (when === 'upcoming') return STATUS_FILTERS.filter((f) => !CLOSED.includes(f.key));
    return STATUS_FILTERS;
  });

  /** The filters as query params (for the URL and the detail page's way back). */
  protected readonly queryParams = computed<Params>(() => ({
    ...(this.when() !== 'all' ? { when: this.when() } : {}),
    ...(this.status() ? { status: this.status() } : {}),
  }));

  protected readonly rows = computed<Row[]>(() =>
    this.items().map((a) => ({ a, badge: appointmentBadge(a), when: appointmentWhen(a), payment: this.paymentLabel(a) })),
  );

  protected readonly emptyText = computed(() => {
    switch (this.when()) {
      case 'attention':
        return 'Nothing needs attention — every consultation that has ended is closed.';
      case 'upcoming':
        return 'No upcoming appointments here.';
      case 'past':
        return 'No past appointments here.';
      default:
        return 'No appointments.';
    }
  });

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const when = WHEN_FILTERS.find((f) => f.key === q.get('when'))?.key ?? 'all';
      this.when.set(when);
      const status = q.get('status') ?? '';
      this.status.set(this.statusFilters().some((f) => f.key === status) ? status : '');
      this.reload();
    });
    this.countAttention();
  }

  protected setWhen(key: WhenKey): void {
    if (this.when() === key) return;
    const status = this.status();
    const keep = key === 'attention' ? OPEN.includes(status) : key === 'upcoming' ? !CLOSED.includes(status) : true;
    this.navigate(key, keep ? status : '');
  }

  protected setStatus(key: string): void {
    if (this.status() === key) return;
    this.navigate(this.when(), key);
  }

  protected reload(): void {
    this.page = 1;
    this.items.set([]);
    this.fetch();
  }

  protected loadMore(): void {
    if (this.loading()) return;
    this.page += 1;
    this.fetch();
  }

  private navigate(when: WhenKey, status: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { when: when === 'all' ? null : when, status: status || null },
      replaceUrl: true,
    });
  }

  private fetch(): void {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.loadError.set('');
    const when = this.when();
    this.sub = this.api
      .list({
        page: this.page,
        per_page: 20,
        ...(this.status() ? { status: this.status() } : {}),
        ...(when !== 'all' ? { when } : {}),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.total.set(res.meta.total);
          if (when === 'all' && !this.status()) this.allTotal.set(res.meta.total);
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loading.set(false);
          // The attention list is the count itself.
          if (when === 'attention' && !this.status()) this.attentionCount.set(res.meta.total);
        },
        error: (err: unknown) => {
          if (this.page > 1) this.page -= 1;
          this.loadError.set(apiErrorMessage(err, 'Could not load appointments.'));
          this.loading.set(false);
        },
      });
  }

  private countAttention(): void {
    this.api
      .list({ when: 'attention', per_page: 1 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (res) => this.attentionCount.set(res.meta.total), error: () => undefined });
  }

  private paymentLabel(a: AppointmentDto): string {
    if (!(Number(a.amount) > 0)) return 'Free';
    const base = PAYMENT_LABEL[a.payment_status ?? ''] ?? (a.payment_status || '—');
    return hasRefund(a) && a.payment_status !== 'refunded' ? `${base} · ${naira(a.refunded_amount)} refunded` : base;
  }

  /** "12 Oct 2026" — the day the consultation a follow-up follows took place. */
  protected day(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }
  protected money(amount: string): string {
    return naira(amount);
  }
  protected formatCount(n: number): string {
    return n.toLocaleString('en-GB');
  }
  protected countLabel(n: number): string {
    return `${this.formatCount(n)} ${n === 1 ? 'appointment' : 'appointments'}`;
  }
}
