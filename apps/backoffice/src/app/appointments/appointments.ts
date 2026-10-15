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
import { IconComponent } from '@supadoc/ui';
import {
  appointmentBadge,
  AppointmentBadge,
  appointmentWhen,
  ATTENTION_BADGE,
  hasRefund,
  naira,
} from '../shared/appointment-status';
import { FOCUS_RING, PILL } from '../specialists/specialist-ui';

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
  imports: [NgTemplateOutlet, RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Appointments</h1>
          <p class="font-sans text-body text-slate">Every consultation across the platform.</p>
        </div>
        @if (canCreate()) {
          <a routerLink="/appointments/new" class="flex min-h-11 shrink-0 items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean ${FOCUS_RING}">
            <sd-icon name="plus" [size]="18" />New appointment
          </a>
        }
      </header>

      <div class="flex flex-col gap-3">
        <div class="-mx-1 overflow-x-auto px-1 pb-1">
          <div class="flex w-max gap-1 rounded-pill border border-cloud bg-white p-1" role="group" aria-label="When">
            @for (f of whenFilters; track f.key) {
              <button
                type="button"
                class="inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors ${FOCUS_RING}"
                [class]="when() === f.key ? 'bg-frost text-cerulean' : 'text-slate hover:text-ink'"
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
        </div>
        <div class="flex flex-wrap gap-2" role="group" aria-label="Status">
          @for (f of statusFilters(); track f.key) {
            <button
              type="button"
              class="inline-flex min-h-11 items-center gap-1.5 rounded-pill px-3.5 py-2 font-sans text-body-sm transition-colors ${FOCUS_RING}"
              [class]="status() === f.key ? 'bg-cerulean text-white' : 'bg-white text-slate ring-1 ring-cloud hover:text-ink'"
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
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white px-5 py-12 text-center font-sans text-body-sm text-slate">
          @if (loading()) {
            <div class="sd-shimmer h-24 w-full rounded-field" aria-hidden="true"></div>
          } @else if (loadError()) {
            <sd-icon name="wifi-off" [size]="28" class="text-alert" />
            <p role="alert">{{ loadError() }}</p>
            <button type="button" class="min-h-11 rounded-field border border-cloud px-4 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean ${FOCUS_RING}" (click)="reload()">Retry</button>
          } @else {
            <sd-icon [name]="when() === 'attention' ? 'circle-check' : 'calendar-days'" [size]="28" [class]="when() === 'attention' ? 'text-sage' : 'text-slate'" />
            <p>{{ emptyText() }}</p>
          }
        </div>
      } @else {
        <!-- Phones: one card per consultation -->
        <ul class="flex flex-col gap-3 md:hidden">
          @for (r of rows(); track r.a.id) {
            <li>
              <a
                [routerLink]="['/appointments', r.a.id]"
                [state]="{ listQuery: queryParams() }"
                class="flex flex-col gap-2 rounded-card border bg-white p-4 transition-colors hover:border-cerulean/50 ${FOCUS_RING}"
                [class]="r.a.needs_attention ? 'border-warning' : 'border-cloud'"
              >
                <div class="flex items-start justify-between gap-3">
                  <span class="flex min-w-0 flex-col">
                    <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ r.a.patient?.name || 'Patient' }}</span>
                    <span class="truncate font-sans text-caption text-slate">with {{ r.a.specialist.name }}</span>
                  </span>
                  <span class="shrink-0 text-right font-sans text-body-sm font-semibold text-ink">{{ money(r.a.amount) }}</span>
                </div>
                <span class="font-sans text-caption text-slate">{{ r.when }} · {{ r.a.type_label }}</span>
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
        <div class="hidden overflow-x-auto rounded-card border border-cloud bg-white md:block">
          <table class="w-full min-w-[760px] text-left">
            <thead class="border-b border-cloud font-sans text-caption text-slate">
              <tr>
                <th class="px-4 py-3">Patient</th>
                <th class="px-4 py-3">Specialist</th>
                <th class="px-4 py-3">When</th>
                <th class="px-4 py-3">Amount</th>
                <th class="px-4 py-3">Status</th>
                <th class="px-4 py-3"><span class="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              @for (r of rows(); track r.a.id) {
                <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink" [class]="r.a.needs_attention ? 'bg-warning/5' : ''">
                  <td class="px-4 py-3 align-top">
                    <span class="font-medium">{{ r.a.patient?.name || '—' }}</span>
                    <span class="block text-caption text-slate">{{ r.a.patient?.email }}</span>
                  </td>
                  <td class="px-4 py-3 align-top">
                    <span class="font-medium">{{ r.a.specialist.name }}</span>
                    <span class="block text-caption text-slate">{{ r.a.specialist.specialty }}</span>
                  </td>
                  <td class="px-4 py-3 align-top text-slate">
                    {{ r.when }}
                    <span class="block text-caption">
                      {{ r.a.type_label }}
                      @if (r.a.parent_appointment_id) {
                        · <a [routerLink]="['/appointments', r.a.parent_appointment_id]" class="font-semibold text-cerulean hover:underline">follow-up of {{ r.a.parent ? day(r.a.parent.scheduled_at) : 'an earlier visit' }}</a>
                      }
                    </span>
                  </td>
                  <td class="px-4 py-3 align-top">
                    {{ money(r.a.amount) }}
                    <span class="block text-caption text-slate">{{ r.payment }}</span>
                  </td>
                  <td class="px-4 py-3 align-top">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <ng-container [ngTemplateOutlet]="badgeTpl" [ngTemplateOutletContext]="{ $implicit: r }" />
                    </div>
                    @if (r.badge.detail) {
                      <span class="mt-1 block text-caption text-slate">{{ r.badge.detail }}</span>
                    }
                  </td>
                  <td class="px-4 py-3 text-right align-top">
                    <a
                      [routerLink]="['/appointments', r.a.id]"
                      [state]="{ listQuery: queryParams() }"
                      class="inline-flex min-h-11 items-center font-sans text-caption font-semibold text-cerulean hover:underline ${FOCUS_RING}"
                      [attr.aria-label]="(r.a.needs_attention ? 'Resolve' : 'Open') + ' the appointment of ' + (r.a.patient?.name || 'the patient') + ' with ' + r.a.specialist.name"
                    >
                      {{ r.a.needs_attention ? 'Resolve' : 'Open' }}
                    </a>
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

      @if (loadError() && rows().length > 0) {
        <p class="text-center font-sans text-caption text-alert" role="alert">{{ loadError() }}</p>
      }

      @if (hasMore()) {
        <button type="button" class="mx-auto min-h-11 rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60 ${FOCUS_RING}" [disabled]="loading()" (click)="loadMore()">
          {{ loading() ? 'Loading…' : 'Load more' }}
        </button>
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
  protected readonly when = signal<WhenKey>('all');
  protected readonly status = signal('');
  protected readonly items = signal<AppointmentDto[]>([]);
  protected readonly total = signal(0);
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
}
