import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { AdminDashboardKpi, AdminDashboardPeriod } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { ICON_CHIP, STAT_GRID, STAT_LABEL, STAT_SUB, STAT_TILE, STAT_VALUE } from '../shared/layout';
import {
  compareLabel,
  kpiDelta,
  kpiExact,
  kpiInlineSub,
  kpiLook,
  kpiNote,
  kpiValue,
  type KpiDelta,
} from './dashboard-ui';

interface Tile {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly exact: string;
  readonly icon: string;
  readonly tint: string;
  readonly inlineSub: string | null;
  readonly delta: KpiDelta | null;
  /** Under the delta, or in its place for a snapshot ("of 12 approved", "No-show: Patient 3"). */
  readonly note: string | null;
  readonly snapshot: boolean;
}

/**
 * The KPI tiles (the doctor dashboard's stat cards): label + tinted icon chip,
 * the value, and its change against the previous equal period — an arrow,
 * words ("Up 12.5%") and colour, with good / bad following the measure (more
 * refunds is worse).
 */
@Component({
  selector: 'bo-dash-kpis',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <h2 class="sr-only">Key figures {{ phrase() }}</h2>
    <ul class="${STAT_GRID}">
      @for (t of tiles(); track t.key) {
        <li class="${STAT_TILE}">
          <div class="flex items-start justify-between gap-2">
            <span class="${STAT_LABEL}">{{ t.label }}</span>
            <span class="${ICON_CHIP}" [class]="t.tint" aria-hidden="true">
              <sd-icon [name]="t.icon" [size]="16" />
            </span>
          </div>
          <p class="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <!-- kpiValue keeps money short; wrap-anywhere is the last resort so nothing leaves the tile. -->
            <span class="${STAT_VALUE} min-w-0 wrap-anywhere" [attr.title]="t.exact">
              <span aria-hidden="true">{{ t.value }}</span><span class="sr-only">{{ t.exact }}</span>
            </span>
            @if (t.inlineSub) {
              <span class="${STAT_SUB}">{{ t.inlineSub }}</span>
            }
          </p>
          @if (t.delta; as d) {
            <p class="flex flex-wrap items-center gap-x-1.5">
              <span class="flex items-center gap-1 font-sans text-caption font-semibold text-ink" aria-hidden="true">
                <span class="flex size-4 items-center justify-center rounded-full" [class]="d.chip"><sd-icon [name]="d.icon" [size]="12" /></span>{{ d.text }}
              </span>
              <span class="font-sans text-caption text-slate" aria-hidden="true">{{ compare() }}</span>
              <span class="sr-only">{{ d.srText }}</span>
            </p>
          } @else if (t.snapshot) {
            <p class="font-sans text-caption text-slate">Right now</p>
          }
          @if (t.note) {
            <p class="font-sans text-caption text-slate">{{ t.note }}</p>
          }
        </li>
      }
    </ul>
  `,
})
export class DashboardKpis {
  readonly kpis = input.required<readonly AdminDashboardKpi[]>();
  readonly period = input.required<AdminDashboardPeriod>();
  readonly currency = input('NGN');

  protected readonly compare = computed(() => compareLabel(this.period()));
  protected readonly phrase = computed(() => {
    const p = this.period();
    return p === 'today' ? 'today' : p === '7d' ? 'for the last 7 days' : 'for the last 30 days';
  });

  protected readonly tiles = computed<Tile[]>(() => {
    const currency = this.currency();
    const compare = this.compare();
    return this.kpis().map((k) => {
      const look = kpiLook(k.key);
      return {
        key: k.key,
        label: k.label,
        value: kpiValue(k, currency),
        exact: kpiExact(k, currency),
        icon: look.icon,
        tint: look.tint,
        inlineSub: kpiInlineSub(k),
        delta: kpiDelta(k, compare, currency),
        note: kpiNote(k),
        snapshot: k.previous === null && k.key === 'active_doctors',
      };
    });
  });
}
