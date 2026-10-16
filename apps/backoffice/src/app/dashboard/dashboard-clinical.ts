import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { MonitoringOverviewDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import {
  ICON_CHIP,
  SECTION_HEAD,
  SECTION_SUBTITLE,
  SECTION_TITLE,
  STAT_GRID,
  STAT_LABEL,
  STAT_SUB,
  STAT_TILE,
  STAT_VALUE,
  TINT,
} from '../shared/layout';

interface Tile {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly icon: string;
  readonly tint: string;
  readonly sub: string | null;
}

const COUNT = new Intl.NumberFormat();

/**
 * Clinical records on the platform so far (monitoring.view) — the totals the
 * old overview showed: clinical notes, prescriptions, lab orders, referrals
 * and recordings (with how many are recording now). Counts only — never
 * what any record says.
 */
@Component({
  selector: 'bo-dash-clinical',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'flex flex-col gap-3' },
  template: `
    <div class="${SECTION_HEAD}">
      <div class="flex min-w-0 flex-col gap-0.5">
        <h2 class="${SECTION_TITLE}">
          <sd-icon name="file-text" [size]="20" class="text-cerulean" />Clinical records
        </h2>
        <p class="${SECTION_SUBTITLE}">All time, across every doctor</p>
      </div>
    </div>
    <ul class="${STAT_GRID}">
      @for (t of tiles(); track t.key) {
        <li class="${STAT_TILE}">
          <div class="flex items-start justify-between gap-2">
            <span class="${STAT_LABEL}">{{ t.label }}</span>
            <span class="${ICON_CHIP}" [class]="t.tint" aria-hidden="true">
              <sd-icon [name]="t.icon" [size]="16" />
            </span>
          </div>
          <p class="${STAT_VALUE} min-w-0 wrap-anywhere">{{ format(t.value) }}</p>
          @if (t.sub) {
            <p class="${STAT_SUB}">{{ t.sub }}</p>
          }
        </li>
      }
    </ul>
  `,
})
export class DashboardClinical {
  readonly overview = input.required<MonitoringOverviewDto>();

  protected readonly tiles = computed<Tile[]>(() => {
    const o = this.overview();
    const n = (v: unknown): number => Math.max(0, Number(v) || 0);
    const live = n(o.recordings?.active);
    return [
      { key: 'notes', label: 'Clinical notes', value: n(o.clinical_notes), icon: 'file-text', tint: TINT.brand, sub: null },
      { key: 'rx', label: 'Prescriptions', value: n(o.prescriptions), icon: 'pill', tint: TINT.success, sub: null },
      { key: 'labs', label: 'Lab orders', value: n(o.lab_orders), icon: 'flask-conical', tint: TINT.teal, sub: null },
      { key: 'referrals', label: 'Referrals', value: n(o.referrals), icon: 'share-2', tint: TINT.blue, sub: null },
      {
        key: 'recordings',
        label: 'Recordings',
        value: n(o.recordings?.total),
        icon: 'video',
        tint: live > 0 ? TINT.danger : TINT.neutral,
        sub: live > 0 ? `${COUNT.format(live)} recording now` : null,
      },
    ];
  });

  protected format(value: number): string {
    return COUNT.format(value);
  }
}
