import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AdminDashboardAttentionItem } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { LIST_CARD, LIST_CARD_BODY, LIST_CARD_HEAD, SECTION_TITLE } from '../shared/layout';
import {
  attentionIcon,
  attentionTint,
  formatCount,
  formatMoney,
  GROUP_LABEL,
  ROW_LINK,
  ROW_STATIC,
} from './dashboard-ui';

interface Row {
  readonly item: AdminDashboardAttentionItem;
  readonly icon: string;
  readonly tint: string;
  readonly count: string;
  readonly amount: string | null;
}

/**
 * "Needs your attention": every queue the viewer can work on, as a count
 * linking to the already-filtered page. Queues with something waiting come
 * first (alert, then warning, then info); the empty ones are listed as
 * "All clear" so nothing looks forgotten.
 */
@Component({
  selector: 'bo-dash-attention',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, IconComponent],
  host: { class: 'flex min-w-0' },
  template: `
    <section class="${LIST_CARD} w-full" aria-labelledby="dash-attention-title">
      <div class="${LIST_CARD_HEAD}">
        <h2 id="dash-attention-title" class="${SECTION_TITLE}"><sd-icon name="list-checks" [size]="20" class="text-cerulean" />Needs your attention</h2>
        @if (waitingTotal() > 0) {
          <span class="inline-flex items-center gap-1.5 rounded-pill bg-warning/15 px-2.5 py-0.5 font-sans text-caption font-semibold text-ink">
            <sd-icon name="triangle-alert" [size]="13" class="text-warning" />{{ formatCount(waitingTotal()) }} waiting
          </span>
        } @else if (items().length > 0) {
          <span class="inline-flex items-center gap-1.5 rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-caption font-semibold text-ink">
            <sd-icon name="circle-check" [size]="13" class="text-sage" />All clear
          </span>
        }
      </div>

      @if (open().length > 0) {
        <ul class="${LIST_CARD_BODY}">
          @for (r of open(); track r.item.key) {
            <li>
              @if (r.item.link; as l) {
                <a [routerLink]="l.path" [queryParams]="l.query" class="${ROW_LINK}">
                  <ng-container *ngTemplateOutlet="row; context: { $implicit: r, linked: true }" />
                </a>
              } @else {
                <div class="${ROW_STATIC}">
                  <ng-container *ngTemplateOutlet="row; context: { $implicit: r, linked: false }" />
                </div>
              }
            </li>
          }
        </ul>
      } @else if (items().length > 0) {
        <div class="flex flex-col items-center gap-2 px-5 py-8 text-center">
          <span class="flex size-12 items-center justify-center rounded-full bg-sage/15 text-sage"><sd-icon name="circle-check" [size]="24" /></span>
          <p class="font-sans text-body-sm font-semibold text-ink">Nothing is waiting for you</p>
          <p class="font-sans text-caption text-slate">Every queue below is empty.</p>
        </div>
      }

      @if (clear().length > 0) {
        <h3 class="${GROUP_LABEL}" [class.border-t]="open().length > 0" [class.border-cloud]="open().length > 0">All clear</h3>
        <ul class="flex flex-wrap gap-2 px-5 pb-5 pt-2">
          @for (r of clear(); track r.item.key) {
            <li class="inline-flex items-center gap-1.5 rounded-pill bg-glacier px-3 py-1 font-sans text-caption text-slate">
              <sd-icon name="check" [size]="13" class="text-sage" />{{ r.item.label }}
            </li>
          }
        </ul>
      }
    </section>

    <ng-template #row let-r let-linked="linked">
      <span class="flex size-10 shrink-0 items-center justify-center rounded-full" [class]="r.tint" aria-hidden="true">
        <sd-icon [name]="r.icon" [size]="18" />
      </span>
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="font-sans text-body-sm font-semibold text-ink">{{ r.item.label }}</span>
        <span class="font-sans text-caption text-slate">{{ r.item.description }}</span>
        @if (!linked) {
          <span class="font-sans text-caption text-slate">No back-office list for these yet — support settles them.</span>
        }
      </span>
      <span class="flex shrink-0 flex-col items-end">
        <span class="font-heading text-h5 text-ink">{{ r.count }}</span>
        @if (r.amount) { <span class="font-sans text-caption text-slate">{{ r.amount }}</span> }
      </span>
      @if (linked) { <sd-icon name="chevron-right" [size]="18" class="shrink-0 text-slate" /> }
    </ng-template>
  `,
})
export class DashboardAttention {
  readonly items = input.required<readonly AdminDashboardAttentionItem[]>();
  readonly currency = input('NGN');

  protected readonly formatCount = formatCount;

  private readonly rows = computed<Row[]>(() =>
    this.items().map((item) => ({
      item,
      icon: attentionIcon(item.key),
      tint: attentionTint(item.tone),
      count: formatCount(item.count),
      amount: item.amount !== null && Number(item.amount) > 0 ? formatMoney(item.amount, this.currency()) : null,
    })),
  );

  /** Queues with something waiting, the most urgent tone first (API order within a tone). */
  protected readonly open = computed(() => {
    const rank: Record<string, number> = { alert: 0, warning: 1, info: 2 };
    return this.rows()
      .filter((r) => r.item.count > 0)
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (rank[a.r.item.tone] ?? 3) - (rank[b.r.item.tone] ?? 3) || a.i - b.i)
      .map(({ r }) => r);
  });
  protected readonly clear = computed(() => this.rows().filter((r) => r.item.count <= 0));
  protected readonly waitingTotal = computed(() => this.open().reduce((sum, r) => sum + r.item.count, 0));
}
