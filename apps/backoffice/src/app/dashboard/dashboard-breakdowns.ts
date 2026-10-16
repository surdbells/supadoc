import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type {
  AdminDashboardPeriod,
  AdminDashboardSpecialtyRow,
  AdminDashboardStatusCount,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { APPOINTMENT_STATUS_COLOR, appointmentBadge } from '../shared/appointment-status';
import {
  LIST_CARD,
  LIST_CARD_EMPTY,
  LIST_CARD_FOOT,
  LIST_CARD_HEAD,
  SECTION_SUBTITLE,
  SECTION_TITLE,
} from '../shared/layout';
import { breakdownCaption, formatCount, formatMoney, periodPhrase, plural } from './dashboard-ui';

/**
 * Share of the whole as a % to one decimal. A non-zero share never rounds
 * to 0: it is at least 0.1, so its bar shows a sliver and its label isn't
 * "0%" beside a count of 1.
 */
export function sharePct(part: number, whole: number): number {
  if (!(whole > 0) || !(part > 0)) return 0;
  const v = Math.round((part / whole) * 1000) / 10;
  return v === 0 ? 0.1 : v;
}

/**
 * Appointments by status for the period: one bar per status (all six, in
 * the API's order) as a share of the total, with the count and % in words.
 */
@Component({
  selector: 'bo-dash-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'flex min-w-0' },
  template: `
    <section class="${LIST_CARD} w-full" aria-labelledby="dash-status-title">
      <div class="${LIST_CARD_HEAD}">
        <div class="flex min-w-0 flex-col">
          <h2 id="dash-status-title" class="${SECTION_TITLE}"><sd-icon name="calendar-check" [size]="20" class="text-cerulean" />Appointments by status</h2>
          <span class="${SECTION_SUBTITLE}">{{ caption() }}</span>
        </div>
        @if (total() > 0) {
          <span class="font-sans text-body-sm font-semibold text-ink">{{ totalLabel() }}</span>
        }
      </div>
      @if (total() === 0) {
        <div class="${LIST_CARD_EMPTY}">
          <sd-icon name="calendar-off" [size]="28" class="text-slate" />
          <p class="font-sans text-body-sm text-slate">No consultations scheduled {{ phrase() }}.</p>
        </div>
      } @else {
        <ul class="flex flex-col gap-3.5 px-5 py-4">
          @for (r of rows(); track r.status) {
            <li class="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_auto] items-center gap-3">
              <span class="flex min-w-0 items-center gap-2 font-sans text-body-sm text-ink">
                <sd-icon [name]="r.icon" [size]="15" [class]="r.text" />
                <span class="truncate">{{ r.label }}</span>
              </span>
              <span class="h-2 overflow-hidden rounded-pill bg-glacier" aria-hidden="true">
                <span class="block h-full rounded-pill" [class]="r.bg" [style.width.%]="r.pct"></span>
              </span>
              <span class="whitespace-nowrap text-right font-sans text-body-sm font-semibold text-ink tabular-nums">
                {{ r.count }}<span class="font-normal text-slate"> · {{ r.pct }}%</span>
              </span>
            </li>
          }
        </ul>
      }
      @if (canOpenAppointments()) {
        <a routerLink="/appointments" class="${LIST_CARD_FOOT}">Manage appointments <sd-icon name="arrow-right" [size]="16" /></a>
      }
    </section>
  `,
})
export class DashboardStatus {
  readonly statuses = input.required<readonly AdminDashboardStatusCount[]>();
  readonly period = input.required<AdminDashboardPeriod>();
  readonly canOpenAppointments = input(false);

  protected readonly caption = computed(() => breakdownCaption(this.period()));
  protected readonly phrase = computed(() => (this.period() === 'today' ? 'for today' : periodPhrase(this.period())));
  protected readonly total = computed(() => this.statuses().reduce((s, r) => s + (r.count || 0), 0));
  protected readonly totalLabel = computed(() => plural(this.total(), 'consultation'));

  protected readonly rows = computed(() => {
    const total = this.total();
    return this.statuses().map((r) => {
      const text = APPOINTMENT_STATUS_COLOR[r.status] ?? 'text-slate';
      return {
        status: r.status,
        label: r.label,
        count: formatCount(r.count),
        pct: sharePct(r.count, total),
        icon: appointmentBadge({ status: r.status, status_label: r.label }).icon,
        text,
        bg: text.replace('text-', 'bg-'),
      };
    });
  });
}

/** The specialties with the most bookings in the period (bar = bookings vs the top one). */
@Component({
  selector: 'bo-dash-specialties',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'flex min-w-0' },
  template: `
    <section class="${LIST_CARD} w-full" aria-labelledby="dash-specialties-title">
      <div class="${LIST_CARD_HEAD}">
        <div class="flex min-w-0 flex-col">
          <h2 id="dash-specialties-title" class="${SECTION_TITLE}"><sd-icon name="stethoscope" [size]="20" class="text-cerulean" />Top specialties</h2>
          <span class="${SECTION_SUBTITLE}">{{ caption() }}</span>
        </div>
      </div>
      @if (rows().length === 0) {
        <div class="${LIST_CARD_EMPTY}">
          <sd-icon name="stethoscope" [size]="28" class="text-slate" />
          <p class="font-sans text-body-sm text-slate">No bookings {{ phrase() }}.</p>
        </div>
      } @else {
        <ol class="flex flex-col gap-4 px-5 py-4">
          @for (r of rows(); track r.specialty) {
            <li class="flex flex-col gap-1.5">
              <div class="flex items-baseline justify-between gap-3 font-sans text-body-sm">
                <span class="min-w-0 truncate text-ink">{{ r.specialty }}</span>
                <span class="shrink-0 font-semibold text-ink tabular-nums">{{ r.bookings }}</span>
              </div>
              <span class="h-2 overflow-hidden rounded-pill bg-glacier" aria-hidden="true">
                <span class="block h-full rounded-pill bg-cerulean" [style.width.%]="r.width"></span>
              </span>
              <span class="font-sans text-caption text-slate">{{ r.detail }}</span>
            </li>
          }
        </ol>
      }
    </section>
  `,
})
export class DashboardSpecialties {
  readonly specialties = input.required<readonly AdminDashboardSpecialtyRow[]>();
  readonly period = input.required<AdminDashboardPeriod>();
  readonly currency = input('NGN');

  protected readonly caption = computed(() => breakdownCaption(this.period()));
  protected readonly phrase = computed(() => (this.period() === 'today' ? 'for today' : periodPhrase(this.period())));

  protected readonly rows = computed(() => {
    const list = this.specialties();
    const max = Math.max(1, ...list.map((r) => r.bookings || 0));
    return list.map((r) => ({
      specialty: r.specialty || 'Not set',
      bookings: plural(r.bookings, 'booking'),
      width: Math.round(((r.bookings || 0) / max) * 100),
      detail:
        `${formatCount(r.completed)} completed` +
        (r.revenue !== null ? ` · ${formatMoney(r.revenue, this.currency())} revenue` : ''),
    }));
  });
}
