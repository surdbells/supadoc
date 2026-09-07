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
import { MonitoringApi } from '@supadoc/data-access';
import type { AnalyticsDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

type Range = AnalyticsDto['range'];

interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  value: number;
}
interface Segment {
  d: string;
  colorClass: string;
  label: string;
  value: number;
  pct: number;
}

const CHART_W = 640;
const CHART_H = 200;
const PAD = { top: 12, right: 12, bottom: 22, left: 44 };

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-warning',
  confirmed: 'text-sage',
  rescheduled: 'text-slate',
  completed: 'text-cerulean',
  cancelled: 'text-alert',
};
const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  rescheduled: 'Rescheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const NAIRA = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  maximumFractionDigits: 0,
});

/**
 * Back-office analytics (route `/analytics`) — booking + revenue trends, status
 * mix, and top specialists. Charts are hand-rendered SVG bound to computed
 * geometry (no innerHTML / bypassSecurityTrust), per the project's chart policy.
 */
@Component({
  selector: 'bo-analytics',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Analytics</h1>
          <p class="font-sans text-body text-slate">Bookings and revenue across the platform.</p>
        </div>
        <div class="flex rounded-field border border-cloud bg-white p-1">
          @for (r of ranges; track r.key) {
            <button
              type="button"
              class="rounded-[6px] px-3 py-1.5 font-sans text-caption font-semibold transition-colors"
              [class]="range() === r.key ? 'bg-cerulean text-white' : 'text-slate hover:text-ink'"
              (click)="setRange(r.key)"
            >{{ r.label }}</button>
          }
        </div>
      </header>

      @if (loading()) {
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          @for (i of [1,2,3,4]; track i) { <div class="sd-shimmer h-24 rounded-card"></div> }
        </div>
        <div class="sd-shimmer h-64 rounded-card"></div>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
        </div>
      } @else if (data(); as d) {
        <!-- KPIs -->
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div class="rounded-card border border-cloud bg-white p-4">
            <div class="flex items-center gap-2 text-slate"><sd-icon name="banknote" [size]="16" /><span class="font-sans text-caption">Revenue (paid)</span></div>
            <p class="mt-1 font-heading text-h4 text-ink">{{ money(d.kpis.revenue) }}</p>
          </div>
          <div class="rounded-card border border-cloud bg-white p-4">
            <div class="flex items-center gap-2 text-slate"><sd-icon name="calendar-days" [size]="16" /><span class="font-sans text-caption">Appointments</span></div>
            <p class="mt-1 font-heading text-h4 text-ink">{{ d.kpis.appointments }}</p>
          </div>
          <div class="rounded-card border border-cloud bg-white p-4">
            <div class="flex items-center gap-2 text-slate"><sd-icon name="credit-card" [size]="16" /><span class="font-sans text-caption">Avg. fee (paid)</span></div>
            <p class="mt-1 font-heading text-h4 text-ink">{{ money(d.kpis.avg_fee) }}</p>
          </div>
          <div class="rounded-card border border-cloud bg-white p-4">
            <div class="flex items-center gap-2 text-slate"><sd-icon name="circle-check" [size]="16" /><span class="font-sans text-caption">Completion</span></div>
            <p class="mt-1 font-heading text-h4 text-ink">{{ d.kpis.completion_rate }}%</p>
          </div>
        </div>

        <!-- Revenue trend -->
        <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
          <h2 class="font-heading text-body-lg text-ink">Revenue over time</h2>
          @if (hasData()) {
            <svg [attr.viewBox]="viewBox" class="w-full" [style.height.px]="260" role="img" aria-label="Revenue trend">
              @for (g of yGrid(); track g.y) {
                <line [attr.x1]="padLeft" [attr.y1]="g.y" [attr.x2]="chartRight" [attr.y2]="g.y" class="text-cloud" stroke="currentColor" stroke-width="1" />
                <text [attr.x]="padLeft - 6" [attr.y]="g.y + 3" text-anchor="end" class="fill-slate" style="font-size:10px">{{ moneyShort(g.value) }}</text>
              }
              <path [attr.d]="revenueArea()" class="text-cerulean" fill="currentColor" fill-opacity="0.12" />
              <path [attr.d]="revenueLine()" class="text-cerulean" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
              @for (t of xTicks(); track t.x) {
                <text [attr.x]="t.x" [attr.y]="chartHeight - 6" text-anchor="middle" class="fill-slate" style="font-size:10px">{{ t.label }}</text>
              }
            </svg>
          } @else {
            <p class="py-12 text-center font-sans text-body-sm text-slate">No bookings in this period.</p>
          }
        </section>

        <!-- Appointments per period -->
        <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
          <h2 class="font-heading text-body-lg text-ink">Appointments booked</h2>
          @if (hasData()) {
            <svg [attr.viewBox]="viewBox" class="w-full" [style.height.px]="240" role="img" aria-label="Appointments booked">
              @for (g of countGrid(); track g.y) {
                <line [attr.x1]="padLeft" [attr.y1]="g.y" [attr.x2]="chartRight" [attr.y2]="g.y" class="text-cloud" stroke="currentColor" stroke-width="1" />
                <text [attr.x]="padLeft - 6" [attr.y]="g.y + 3" text-anchor="end" class="fill-slate" style="font-size:10px">{{ g.value }}</text>
              }
              @for (b of bars(); track b.x) {
                <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h" rx="2" class="text-cerulean" fill="currentColor" fill-opacity="0.85">
                  <title>{{ b.label }}: {{ b.value }}</title>
                </rect>
              }
              @for (t of xTicks(); track t.x) {
                <text [attr.x]="t.x" [attr.y]="chartHeight - 6" text-anchor="middle" class="fill-slate" style="font-size:10px">{{ t.label }}</text>
              }
            </svg>
          } @else {
            <p class="py-12 text-center font-sans text-body-sm text-slate">No bookings in this period.</p>
          }
        </section>

        <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <!-- Status mix (donut) -->
          <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
            <h2 class="font-heading text-body-lg text-ink">Appointment status</h2>
            @if (statusTotal() > 0) {
              <div class="flex items-center gap-6">
                <svg viewBox="0 0 120 120" class="size-32 shrink-0" role="img" aria-label="Status breakdown">
                  @for (s of donut(); track s.label) {
                    <path [attr.d]="s.d" [class]="s.colorClass" fill="none" stroke="currentColor" stroke-width="18" />
                  }
                  <text x="60" y="56" text-anchor="middle" class="fill-ink" style="font-size:18px;font-weight:700">{{ statusTotal() }}</text>
                  <text x="60" y="72" text-anchor="middle" class="fill-slate" style="font-size:9px">total</text>
                </svg>
                <ul class="flex flex-1 flex-col gap-2">
                  @for (s of donut(); track s.label) {
                    <li class="flex items-center gap-2 font-sans text-body-sm">
                      <span class="size-2.5 rounded-full" [class]="dotClass(s.colorClass)"></span>
                      <span class="text-ink">{{ s.label }}</span>
                      <span class="ml-auto font-semibold text-ink">{{ s.value }}</span>
                      <span class="w-10 text-right text-slate">{{ s.pct }}%</span>
                    </li>
                  }
                </ul>
              </div>
            } @else {
              <p class="py-8 text-center font-sans text-body-sm text-slate">No data.</p>
            }
          </section>

          <!-- Top specialists -->
          <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
            <h2 class="font-heading text-body-lg text-ink">Top specialists</h2>
            <ul class="flex flex-col gap-3">
              @for (s of d.top_specialists; track s.id) {
                <li class="flex flex-col gap-1">
                  <div class="flex items-center justify-between font-sans text-body-sm">
                    <span class="text-ink">{{ s.name }}</span>
                    <span class="font-semibold text-ink">{{ money(s.revenue) }}</span>
                  </div>
                  <div class="h-2 overflow-hidden rounded-full bg-glacier">
                    <div class="h-full rounded-full bg-cerulean" [style.width.%]="specialistWidth(s.revenue)"></div>
                  </div>
                  <span class="font-sans text-caption text-slate">{{ s.appointments }} appointment{{ s.appointments === 1 ? '' : 's' }}</span>
                </li>
              } @empty {
                <li class="py-8 text-center font-sans text-body-sm text-slate">No specialist activity yet.</li>
              }
            </ul>
          </section>
        </div>
      }
    </div>
  `,
})
export class AdminAnalytics implements OnInit {
  private readonly api = inject(MonitoringApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly ranges: { key: Range; label: string }[] = [
    { key: '7d', label: '7d' },
    { key: '30d', label: '30d' },
    { key: '90d', label: '90d' },
    { key: '12m', label: '12m' },
  ];

  protected readonly range = signal<Range>('30d');
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly data = signal<AnalyticsDto | null>(null);

  // Chart geometry constants exposed to the template.
  protected readonly viewBox = `0 0 ${CHART_W} ${CHART_H}`;
  protected readonly chartHeight = CHART_H;
  protected readonly padLeft = PAD.left;
  protected readonly chartRight = CHART_W - PAD.right;

  protected readonly hasData = computed(() => (this.data()?.series.length ?? 0) > 0);

  private readonly maxRevenue = computed(() =>
    Math.max(1, ...(this.data()?.series ?? []).map((p) => Number(p.revenue) || 0)),
  );
  private readonly maxCount = computed(() =>
    Math.max(1, ...(this.data()?.series ?? []).map((p) => p.appointments)),
  );

  private x(i: number, n: number): number {
    if (n <= 1) return PAD.left + (CHART_W - PAD.left - PAD.right) / 2;
    return PAD.left + (i * (CHART_W - PAD.left - PAD.right)) / (n - 1);
  }
  private yRev(v: number): number {
    const h = CHART_H - PAD.top - PAD.bottom;
    return PAD.top + h - (v / this.maxRevenue()) * h;
  }

  protected readonly revenueLine = computed(() => {
    const s = this.data()?.series ?? [];
    return s
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${this.x(i, s.length).toFixed(1)},${this.yRev(Number(p.revenue) || 0).toFixed(1)}`)
      .join(' ');
  });

  protected readonly revenueArea = computed(() => {
    const s = this.data()?.series ?? [];
    if (s.length === 0) return '';
    const base = CHART_H - PAD.bottom;
    const line = s
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${this.x(i, s.length).toFixed(1)},${this.yRev(Number(p.revenue) || 0).toFixed(1)}`)
      .join(' ');
    const first = this.x(0, s.length).toFixed(1);
    const last = this.x(s.length - 1, s.length).toFixed(1);
    return `${line} L${last},${base} L${first},${base} Z`;
  });

  protected readonly bars = computed<Bar[]>(() => {
    const s = this.data()?.series ?? [];
    const n = s.length;
    if (n === 0) return [];
    const areaW = CHART_W - PAD.left - PAD.right;
    const slot = areaW / n;
    const w = Math.max(1, Math.min(28, slot * 0.7));
    const h0 = CHART_H - PAD.top - PAD.bottom;
    const base = CHART_H - PAD.bottom;
    return s.map((p, i) => {
      const h = (p.appointments / this.maxCount()) * h0;
      const cx = PAD.left + slot * (i + 0.5);
      return { x: cx - w / 2, y: base - h, w, h, label: p.label, value: p.appointments };
    });
  });

  protected readonly yGrid = computed(() => this.gridLines(this.maxRevenue()));
  protected readonly countGrid = computed(() => this.gridLines(this.maxCount()));

  private gridLines(max: number): { y: number; value: number }[] {
    const steps = 4;
    const h = CHART_H - PAD.top - PAD.bottom;
    const out: { y: number; value: number }[] = [];
    for (let i = 0; i <= steps; i++) {
      const value = (max / steps) * i;
      out.push({ y: PAD.top + h - (h / steps) * i, value: Math.round(value) });
    }
    return out;
  }

  protected readonly xTicks = computed(() => {
    const s = this.data()?.series ?? [];
    const n = s.length;
    if (n === 0) return [];
    const want = Math.min(6, n);
    const out: { x: number; label: string }[] = [];
    for (let k = 0; k < want; k++) {
      const i = want === 1 ? 0 : Math.round((k * (n - 1)) / (want - 1));
      out.push({ x: this.x(i, n), label: this.tickLabel(s[i].label) });
    }
    return out;
  });

  private tickLabel(label: string): string {
    // 'YYYY-MM-DD' -> 'D Mon'; 'YYYY-MM' -> 'Mon'
    const parts = label.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (parts.length === 3) return `${Number(parts[2])} ${months[Number(parts[1]) - 1]}`;
    if (parts.length === 2) return months[Number(parts[1]) - 1];
    return label;
  }

  // ----- Status donut -----
  protected readonly statusTotal = computed(() =>
    Object.values(this.data()?.by_status ?? {}).reduce((a, b) => a + b, 0),
  );

  protected readonly donut = computed<Segment[]>(() => {
    const by = this.data()?.by_status ?? {};
    const total = this.statusTotal();
    if (total === 0) return [];
    const cx = 60;
    const cy = 60;
    const r = 51;
    let angle = -Math.PI / 2;
    const segs: Segment[] = [];
    for (const [key, value] of Object.entries(by)) {
      if (value === 0) continue;
      const frac = value / total;
      const end = angle + frac * Math.PI * 2;
      // A full-circle segment can't be drawn with one arc; nudge it just short.
      const drawEnd = frac >= 1 ? end - 0.001 : end;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(drawEnd);
      const y2 = cy + r * Math.sin(drawEnd);
      const large = frac > 0.5 ? 1 : 0;
      segs.push({
        d: `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`,
        colorClass: STATUS_COLOR[key] ?? 'text-slate',
        label: STATUS_LABEL[key] ?? key,
        value,
        pct: Math.round(frac * 100),
      });
      angle = end;
    }
    return segs;
  });

  protected dotClass(colorClass: string): string {
    // 'text-cerulean' -> 'bg-cerulean'
    return colorClass.replace('text-', 'bg-');
  }

  protected specialistWidth(revenue: string): number {
    const top = this.data()?.top_specialists ?? [];
    const max = Math.max(1, ...top.map((s) => Number(s.revenue) || 0));
    return Math.round(((Number(revenue) || 0) / max) * 100);
  }

  protected money(v: string | number): string {
    return NAIRA.format(Number(v) || 0);
  }
  protected moneyShort(v: number): string {
    if (v >= 1_000_000) return `₦${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `₦${Math.round(v / 1_000)}k`;
    return `₦${Math.round(v)}`;
  }

  ngOnInit(): void {
    this.load();
  }

  protected setRange(r: Range): void {
    if (r === this.range()) return;
    this.range.set(r);
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .analytics(this.range())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Could not load analytics.');
          this.loading.set(false);
        },
      });
  }
}
