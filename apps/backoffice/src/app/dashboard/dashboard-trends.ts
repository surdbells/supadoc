import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { AdminDashboardTrendsDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { LIST_CARD, LIST_CARD_HEAD, SECTION_SUBTITLE, SECTION_TITLE } from '../shared/layout';
import { DashboardTrendChart, type TrendSeries } from './trend-chart';
import { formatCount, formatMoney } from './dashboard-ui';

/**
 * The 30-day trend cards: bookings made vs consultations completed (grouped
 * columns), and revenue (area). Each card shows only when its series came
 * back (the viewer's permissions decide).
 */
@Component({
  selector: 'bo-dash-trends',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, DashboardTrendChart],
  host: { class: 'block' },
  template: `
    <div [class]="activity() && revenue() ? 'grid gap-6 xl:grid-cols-2' : 'grid gap-6'">
      @if (activity(); as series) {
        <section class="${LIST_CARD}" aria-labelledby="dash-trend-activity">
          <div class="${LIST_CARD_HEAD}">
            <h2 id="dash-trend-activity" class="${SECTION_TITLE}"><sd-icon name="chart-column" [size]="20" class="text-cerulean" />Bookings vs completed</h2>
            <span class="${SECTION_SUBTITLE}">Last 30 days, by day</span>
          </div>
          <div class="px-5 py-4">
            <bo-dash-trend-chart
              label="Bookings made and consultations completed per day"
              [summary]="activitySummary()"
              [days]="days()"
              [series]="series"
              kind="columns"
              emptyText="No bookings or completed consultations in the last 30 days."
            />
          </div>
        </section>
      }
      @if (revenue(); as series) {
        <section class="${LIST_CARD}" aria-labelledby="dash-trend-revenue">
          <div class="${LIST_CARD_HEAD}">
            <h2 id="dash-trend-revenue" class="${SECTION_TITLE}"><sd-icon name="banknote" [size]="20" class="text-cerulean" />Revenue</h2>
            <span class="${SECTION_SUBTITLE}">Last 30 days · {{ revenueTotal() }} net of refunds</span>
          </div>
          <div class="px-5 py-4">
            <bo-dash-trend-chart
              label="Revenue per day, net of refunds"
              [summary]="revenueTotal() + ' in the last 30 days'"
              [days]="days()"
              [series]="series"
              kind="area"
              [integer]="false"
              [format]="moneyFull"
              [axisFormat]="moneyAxis"
              emptyText="No paid bookings in the last 30 days."
            />
          </div>
        </section>
      }
    </div>
  `,
})
export class DashboardTrends {
  readonly trends = input.required<AdminDashboardTrendsDto>();
  readonly currency = input('NGN');

  protected readonly days = computed(() => this.trends().days.map((d) => d.date));

  protected readonly activity = computed<TrendSeries[] | null>(() => {
    const t = this.trends();
    const out: TrendSeries[] = [];
    if (t.series.includes('bookings')) {
      out.push({
        key: 'bookings',
        label: 'Booked',
        color: 'cerulean',
        values: t.days.map((d) => d.bookings ?? 0),
        total: formatCount(t.totals.bookings ?? sum(t.days.map((d) => d.bookings ?? 0))),
      });
    }
    if (t.series.includes('completed')) {
      out.push({
        key: 'completed',
        label: 'Completed',
        color: 'sage',
        values: t.days.map((d) => d.completed ?? 0),
        total: formatCount(t.totals.completed ?? sum(t.days.map((d) => d.completed ?? 0))),
      });
    }
    return out.length ? out : null;
  });

  protected readonly activitySummary = computed(() =>
    (this.activity() ?? []).map((s) => `${s.total} ${s.label.toLowerCase()}`).join(', ') + ' in the last 30 days',
  );

  protected readonly revenue = computed<TrendSeries[] | null>(() => {
    const t = this.trends();
    if (!t.series.includes('revenue')) return null;
    return [{ key: 'revenue', label: 'Revenue', color: 'teal', values: t.days.map((d) => Number(d.revenue) || 0) }];
  });

  protected readonly revenueTotal = computed(() => {
    const t = this.trends();
    const total = t.totals.revenue ?? sum(t.days.map((d) => Number(d.revenue) || 0));
    return formatMoney(total, this.currency());
  });

  protected readonly moneyFull = (v: number): string => formatMoney(v, this.currency());
  protected readonly moneyAxis = (v: number): string => formatMoney(v, this.currency(), { compact: true });
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
