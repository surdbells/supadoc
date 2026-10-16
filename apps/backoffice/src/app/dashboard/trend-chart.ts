import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { IconComponent } from '@supadoc/ui';
import {
  areaPath,
  clamp,
  columnPath,
  linePath,
  niceScale,
  tickIndexes,
  yFor,
} from './dashboard-chart';
import { compactNumber, dayLabel, dayShort, formatCount } from './dashboard-ui';

/** Series colours (validated as a pair for colour-blind separation: cerulean ↔ sage). */
export type TrendColor = 'cerulean' | 'sage' | 'teal';

export interface TrendSeries {
  readonly key: string;
  /** "Booked", "Completed", "Revenue". */
  readonly label: string;
  readonly color: TrendColor;
  /** One value per day, aligned with `days`. */
  readonly values: readonly number[];
  /** Shown in the legend beside the label, e.g. "128". */
  readonly total?: string;
}

const COLOR: Record<TrendColor, { text: string; bg: string }> = {
  cerulean: { text: 'text-cerulean', bg: 'bg-cerulean' },
  sage: { text: 'text-sage', bg: 'bg-sage' },
  teal: { text: 'text-teal', bg: 'bg-teal' },
};

const HEIGHT = 220;
const PAD_TOP = 14;
const PAD_BOTTOM = 28;
const PAD_RIGHT = 12;
const PLOT_H = HEIGHT - PAD_TOP - PAD_BOTTOM;
/** Columns: at most this thick, with a 2px surface gap between a day's columns. */
const MAX_COLUMN = 24;
const GAP = 2;

/**
 * A 30-day trend drawn to scale as inline SVG: grouped columns (counts) or an
 * area + line (money). The chart sizes its viewBox to its real width (text
 * stays 11px on a phone), shows a crosshair + tooltip on hover / tap (a tapped
 * day stays until the chart loses focus), and
 * is one tab stop: ← / → (Home / End) read each day aloud, Esc clears. Every
 * value is also in the "View as table" table, so nothing hides behind hover.
 *
 * Usage: `<bo-dash-trend-chart label="Bookings" [days]="days" [series]="series" />`.
 */
@Component({
  selector: 'bo-dash-trend-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block min-w-0', '(document:pointerdown)': 'onOutside($event)' },
  template: `
    @if (series().length > 1) {
      <ul class="mb-3 flex flex-wrap gap-x-5 gap-y-1" aria-label="Legend">
        @for (s of series(); track s.key) {
          <li class="flex items-center gap-2 font-sans text-caption text-slate">
            <span aria-hidden="true" [class]="(kind() === 'columns' ? 'size-2.5 rounded-[3px] ' : 'h-0.5 w-3 rounded-full ') + bg(s)"></span>
            <span>{{ s.label }}</span>
            @if (s.total) { <span class="font-semibold text-ink">{{ s.total }}</span> }
          </li>
        }
      </ul>
    }

    @if (empty()) {
      <div class="flex flex-col items-center justify-center gap-2 rounded-lg bg-glacier/60 text-center" [style.height.px]="height">
        <sd-icon name="chart-column" [size]="28" class="text-slate" />
        <p class="font-sans text-body-sm text-slate">{{ emptyText() }}</p>
      </div>
    } @else {
      <div
        class="relative rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
        tabindex="0"
        role="group"
        [attr.aria-label]="ariaLabel()"
        (keydown)="onKey($event)"
        (focus)="onFocus()"
        (blur)="clear()"
      >
        <svg
          [attr.viewBox]="'0 0 ' + width() + ' ' + height"
          [attr.width]="width()"
          [attr.height]="height"
          class="block h-auto w-full touch-pan-y select-none"
          aria-hidden="true"
          (pointermove)="onPointer($event)"
          (pointerdown)="onPointer($event)"
          (pointerleave)="onLeave($event)"
        >
          <!-- Hover band (columns) -->
          @if (kind() === 'columns' && active() !== null) {
            <rect [attr.x]="bandX()" [attr.y]="padTop" [attr.width]="slot()" [attr.height]="plotH" rx="4" class="text-frost" fill="currentColor" fill-opacity="0.35" />
          }

          <!-- Gridlines + y labels -->
          @for (g of grid(); track g.value) {
            <line [attr.x1]="padLeft()" [attr.x2]="width() - padRight" [attr.y1]="g.y" [attr.y2]="g.y" [class]="g.value === 0 ? 'text-ash' : 'text-cloud'" stroke="currentColor" stroke-width="1" />
            <text [attr.x]="padLeft() - 8" [attr.y]="g.y + 4" text-anchor="end" class="fill-slate font-sans tabular-nums" style="font-size: 11px">{{ g.label }}</text>
          }

          @if (kind() === 'columns') {
            @for (c of columns(); track c.key) {
              <path [attr.d]="c.d" [class]="c.cls" fill="currentColor" />
            }
          } @else {
            @for (l of lines(); track l.key) {
              <path [attr.d]="l.area" [class]="l.cls" fill="currentColor" fill-opacity="0.1" />
              <path [attr.d]="l.line" [class]="l.cls" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
              @if (active() === null && l.last) {
                <circle [attr.cx]="l.last.x" [attr.cy]="l.last.y" r="4" [class]="l.cls" fill="currentColor" stroke="#fcfcfc" stroke-width="2" />
              }
            }
            @if (active() !== null) {
              <line [attr.x1]="activeX()" [attr.x2]="activeX()" [attr.y1]="padTop" [attr.y2]="padTop + plotH" class="text-slate" stroke="currentColor" stroke-width="1" />
              @for (d of activeDots(); track d.key) {
                <circle [attr.cx]="d.x" [attr.cy]="d.y" r="4.5" [class]="d.cls" fill="currentColor" stroke="#fcfcfc" stroke-width="2" />
              }
            }
          }

          <!-- x labels -->
          @for (t of xTicks(); track t.i) {
            <text [attr.x]="t.x" [attr.y]="height - 8" [attr.text-anchor]="t.anchor" class="fill-slate font-sans" style="font-size: 11px">{{ t.label }}</text>
          }
        </svg>

        @if (tip(); as t) {
          <div
            class="pointer-events-none absolute top-0 z-10 flex min-w-32 flex-col gap-1 rounded-lg border border-cloud bg-white px-3 py-2 shadow-[0_6px_18px_rgba(10,22,40,0.12)]"
            [style.left.px]="t.left"
            [class]="t.flip ? '-translate-x-full' : ''"
            aria-hidden="true"
          >
            <span class="font-sans text-caption text-slate">{{ t.day }}</span>
            @for (r of t.rows; track r.key) {
              <span class="flex items-center gap-2 whitespace-nowrap font-sans text-caption">
                <span class="h-0.5 w-3 shrink-0 rounded-full" [class]="r.bg"></span>
                <span class="font-semibold text-ink tabular-nums">{{ r.value }}</span>
                <span class="text-slate">{{ r.label }}</span>
              </span>
            }
          </div>
        }
      </div>
      <p class="sr-only" aria-live="polite">{{ announce() }}</p>

      <details class="group mt-3">
        <summary class="inline-flex min-h-9 cursor-pointer list-none items-center gap-1 rounded-lg font-sans text-caption font-semibold text-cerulean hover:text-ocean focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 [&::-webkit-details-marker]:hidden">
          <sd-icon name="chevron-right" [size]="14" class="inline-flex transition-transform group-open:rotate-90" />View as table
        </summary>
        <div class="mt-2 max-h-72 overflow-auto rounded-lg border border-cloud">
          <table class="w-full border-collapse font-sans text-caption">
            <caption class="sr-only">{{ label() }}, by day (newest first)</caption>
            <thead class="sticky top-0 bg-glacier">
              <tr>
                <th scope="col" class="px-3 py-2 text-left font-semibold text-slate">Day</th>
                @for (s of series(); track s.key) {
                  <th scope="col" class="px-3 py-2 text-right font-semibold text-slate">{{ s.label }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (r of tableRows(); track r.day) {
                <tr class="border-t border-cloud">
                  <th scope="row" class="px-3 py-1.5 text-left font-normal text-ink">{{ r.label }}</th>
                  @for (v of r.values; track $index) {
                    <td class="px-3 py-1.5 text-right text-ink tabular-nums">{{ v }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      </details>
    }
  `,
})
export class DashboardTrendChart {
  /** The chart's name (its accessible name and the table caption). */
  readonly label = input.required<string>();
  /** A one-line summary read with the name, e.g. "128 booked, 96 completed in the last 30 days". */
  readonly summary = input('');
  /** 'YYYY-MM-DD' days, oldest first. */
  readonly days = input.required<readonly string[]>();
  readonly series = input.required<readonly TrendSeries[]>();
  readonly kind = input<'columns' | 'area'>('columns');
  /** Whole-number ticks (counts). */
  readonly integer = input(true);
  /** A value in the tooltip / table / announcement. */
  readonly format = input<(v: number) => string>((v) => formatCount(v));
  /** A y-axis tick label (keep it short). */
  readonly axisFormat = input<(v: number) => string>((v) => compactNumber(v));
  readonly emptyText = input('Nothing in the last 30 days yet.');

  protected readonly height = HEIGHT;
  protected readonly padTop = PAD_TOP;
  protected readonly padRight = PAD_RIGHT;
  protected readonly plotH = PLOT_H;

  /** The rendered width in px — the viewBox follows it so text never shrinks. */
  protected readonly width = signal(640);
  /** The day under the pointer / keyboard focus. */
  protected readonly active = signal<number | null>(null);
  protected readonly announce = signal('');

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    const host = this.host;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const measure = () => {
        const w = Math.round(host.clientWidth);
        if (w > 0 && w !== this.width()) this.width.set(Math.max(240, w));
      };
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(measure);
      ro.observe(host);
      destroyRef.onDestroy(() => ro.disconnect());
    });
  }

  private readonly n = computed(() => this.days().length);

  protected readonly empty = computed(
    () => this.n() === 0 || this.series().every((s) => s.values.every((v) => !v)),
  );

  private readonly scale = computed(() => {
    const all = this.series().flatMap((s) => s.values.map((v) => Number(v) || 0));
    // Columns are counts, drawn up from zero; only the area (money) can dip below it.
    const lo = this.kind() === 'columns' ? 0 : Math.min(0, ...all);
    return niceScale(lo, Math.max(0, ...all), 4, this.integer());
  });

  private readonly tickLabels = computed(() => {
    const fmt = this.axisFormat();
    return this.scale().ticks.map((v) => ({ value: v, label: fmt(v) }));
  });

  /** Room for the longest y label. */
  protected readonly padLeft = computed(() =>
    Math.ceil(Math.max(28, ...this.tickLabels().map((t) => t.label.length * 6.6 + 14))),
  );
  private readonly plotW = computed(() => Math.max(40, this.width() - this.padLeft() - PAD_RIGHT));
  protected readonly slot = computed(() => this.plotW() / Math.max(1, this.n()));

  private y(v: number): number {
    return yFor(v, this.scale(), PAD_TOP, PLOT_H);
  }

  /** The x of day `i` (a column group's centre, or a line point). */
  private cx(i: number): number {
    const n = this.n();
    if (this.kind() === 'columns') return this.padLeft() + this.slot() * (i + 0.5);
    if (n <= 1) return this.padLeft() + this.plotW() / 2;
    return this.padLeft() + (i * this.plotW()) / (n - 1);
  }

  protected readonly grid = computed(() => this.tickLabels().map((t) => ({ ...t, y: this.y(t.value) })));

  protected readonly columns = computed(() => {
    if (this.kind() !== 'columns') return [];
    const series = this.series();
    const k = Math.max(1, series.length);
    const slot = this.slot();
    const gap = k > 1 ? Math.min(GAP, slot * 0.1) : 0;
    const groupW = Math.min(slot * 0.72, k * MAX_COLUMN + (k - 1) * gap);
    const barW = Math.max(1, (groupW - (k - 1) * gap) / k);
    const base = this.y(0);
    const out: { key: string; d: string; cls: string }[] = [];
    for (let i = 0; i < this.n(); i++) {
      const x0 = this.padLeft() + slot * i + (slot - groupW) / 2;
      series.forEach((s, j) => {
        const top = this.y(Math.max(0, Number(s.values[i]) || 0));
        const d = columnPath(x0 + j * (barW + gap), top, barW, base - top, 4);
        if (d) out.push({ key: `${s.key}-${i}`, d, cls: COLOR[s.color].text });
      });
    }
    return out;
  });

  protected readonly lines = computed(() => {
    if (this.kind() !== 'area') return [];
    const base = this.y(0);
    return this.series().map((s) => {
      const pts = s.values.map((v, i) => ({ x: this.cx(i), y: this.y(Number(v) || 0) }));
      return {
        key: s.key,
        cls: COLOR[s.color].text,
        line: linePath(pts),
        area: areaPath(pts, base),
        last: pts.length ? pts[pts.length - 1] : null,
      };
    });
  });

  protected readonly bandX = computed(() => this.padLeft() + this.slot() * (this.active() ?? 0));
  protected readonly activeX = computed(() => this.cx(this.active() ?? 0));
  protected readonly activeDots = computed(() => {
    const i = this.active();
    if (i === null) return [];
    return this.series().map((s) => ({ key: s.key, x: this.cx(i), y: this.y(Number(s.values[i]) || 0), cls: COLOR[s.color].text }));
  });

  protected readonly xTicks = computed(() => {
    const days = this.days();
    const w = this.width();
    return tickIndexes(days.length, this.plotW()).map((i) => {
      let x = this.cx(i);
      let anchor: 'middle' | 'end' | 'start' = 'middle';
      if (x + 22 > w) {
        x = w - 1;
        anchor = 'end';
      } else if (x - 22 < 0) {
        x = 1;
        anchor = 'start';
      }
      return { i, x, anchor, label: dayShort(days[i]) };
    });
  });

  protected readonly tip = computed(() => {
    const i = this.active();
    const days = this.days();
    if (i === null || i >= days.length) return null;
    const fmt = this.format();
    // Beside the crosshair, on the side with more room, so it never covers the day it describes.
    const x = this.cx(i);
    const flip = x > this.width() / 2;
    return {
      left: flip ? x - 10 : x + 10,
      flip,
      day: dayLabel(days[i]),
      rows: this.series().map((s) => ({
        key: s.key,
        label: s.label,
        value: fmt(Number(s.values[i]) || 0),
        bg: COLOR[s.color].bg,
      })),
    };
  });

  protected readonly tableRows = computed(() => {
    const fmt = this.format();
    const series = this.series();
    return this.days()
      .map((day, i) => ({ day, label: dayLabel(day), values: series.map((s) => fmt(Number(s.values[i]) || 0)) }))
      .reverse();
  });

  protected readonly ariaLabel = computed(() => {
    const summary = this.summary();
    return `${this.label()}${summary ? `. ${summary}` : ''}. Use the left and right arrow keys to read each day.`;
  });

  protected bg(s: TrendSeries): string {
    return COLOR[s.color].bg;
  }

  /** "Wed 14 Oct: 5 booked, 3 completed". */
  readout(i: number): string {
    const fmt = this.format();
    const day = this.days()[i];
    if (day === undefined) return '';
    const parts = this.series().map((s) => `${s.label} ${fmt(Number(s.values[i]) || 0)}`);
    return `${dayLabel(day)}: ${parts.join(', ')}`;
  }

  protected onPointer(ev: PointerEvent): void {
    const svg = ev.currentTarget as SVGSVGElement | null;
    const rect = svg?.getBoundingClientRect();
    if (!rect || !rect.width) return;
    const x = ((ev.clientX - rect.left) * this.width()) / rect.width;
    this.active.set(this.indexAt(x));
  }

  /**
   * A mouse / pen leaving the chart clears the day. A finger lifting also
   * fires pointerleave, so a touch keeps the tapped day on screen; it clears
   * on blur (a tap elsewhere) or Esc, and another tap moves it.
   */
  protected onLeave(ev: PointerEvent): void {
    if (ev.pointerType === 'touch') return;
    this.clear();
  }

  /** A tap / click anywhere outside the chart clears a day left showing (touch never sends a leave). */
  protected onOutside(ev: Event): void {
    if (this.active() === null) return;
    const target = ev.target as Node | null;
    if (target && this.host.contains(target)) return;
    this.clear();
  }

  private indexAt(x: number): number {
    const n = this.n();
    if (n <= 1) return 0;
    if (this.kind() === 'columns') return clamp(Math.floor((x - this.padLeft()) / this.slot()), 0, n - 1);
    return clamp(Math.round(((x - this.padLeft()) * (n - 1)) / this.plotW()), 0, n - 1);
  }

  protected onKey(ev: KeyboardEvent): void {
    const n = this.n();
    if (!n) return;
    const cur = this.active() ?? n - 1;
    let next: number;
    switch (ev.key) {
      case 'ArrowLeft':
        next = Math.max(0, cur - 1);
        break;
      case 'ArrowRight':
        next = Math.min(n - 1, cur + 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = n - 1;
        break;
      case 'Escape':
        this.clear();
        return;
      default:
        return;
    }
    ev.preventDefault();
    this.active.set(next);
    this.announce.set(this.readout(next));
  }

  /** Keyboard focus starts on today. */
  protected onFocus(): void {
    if (this.active() !== null) return;
    const i = this.n() - 1;
    this.active.set(i);
    this.announce.set(this.readout(i));
  }

  protected clear(): void {
    this.active.set(null);
  }
}
