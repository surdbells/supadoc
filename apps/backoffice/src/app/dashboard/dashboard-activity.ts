import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AdminDashboardActivityItem } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { relativeTime } from '../shared/appointment-status';
import {
  LIST_CARD,
  LIST_CARD_BODY,
  LIST_CARD_EMPTY,
  LIST_CARD_FOOT,
  LIST_CARD_HEAD,
  SECTION_TITLE,
} from '../shared/layout';
import { activityIcon, dateTime, roleLabel } from './dashboard-ui';

/** Rows top-aligned (a summary can wrap to two lines). */
const ACT_ROW_LINK =
  'flex min-h-11 items-start gap-3 px-5 py-3.5 transition-colors hover:bg-glacier focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cerulean/40';
const ACT_ROW_STATIC = 'flex min-h-11 items-start gap-3 px-5 py-3.5';

/** The latest audit events in words ("Doctor approved · Dr. Grace Bell"), each opening what it concerns. */
@Component({
  selector: 'bo-dash-activity',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, IconComponent],
  host: { class: 'flex min-w-0' },
  template: `
    <section class="${LIST_CARD} w-full" aria-labelledby="dash-activity-title">
      <div class="${LIST_CARD_HEAD}">
        <h2 id="dash-activity-title" class="${SECTION_TITLE}"><sd-icon name="history" [size]="20" class="text-cerulean" />Recent activity</h2>
      </div>
      @if (rows().length === 0) {
        <div class="${LIST_CARD_EMPTY}">
          <sd-icon name="history" [size]="28" class="text-slate" />
          <p class="font-sans text-body-sm text-slate">No recent activity.</p>
        </div>
      } @else {
        <ol class="${LIST_CARD_BODY}">
          @for (r of rows(); track r.id) {
            <li>
              @if (r.link; as l) {
                <a [routerLink]="l.path" [queryParams]="l.query" class="${ACT_ROW_LINK}">
                  <ng-container *ngTemplateOutlet="row; context: { $implicit: r }" />
                </a>
              } @else {
                <div class="${ACT_ROW_STATIC}">
                  <ng-container *ngTemplateOutlet="row; context: { $implicit: r }" />
                </div>
              }
            </li>
          }
        </ol>
      }
      @if (showAuditLink()) {
        <a routerLink="/audit" class="${LIST_CARD_FOOT}">View audit log <sd-icon name="arrow-right" [size]="16" /></a>
      }
    </section>

    <ng-template #row let-r>
      <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean-dark" aria-hidden="true">
        <sd-icon [name]="r.icon" [size]="16" />
      </span>
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="break-words font-sans text-body-sm text-ink">{{ r.summary }}</span>
        <span class="truncate font-sans text-caption text-slate">{{ r.actor }}</span>
      </span>
      <time class="shrink-0 whitespace-nowrap font-sans text-caption text-slate" [attr.datetime]="r.at" [attr.title]="r.exact">{{ r.ago }}</time>
    </ng-template>
  `,
})
export class DashboardActivity {
  readonly items = input.required<readonly AdminDashboardActivityItem[]>();
  /** /audit needs monitoring.view (the same permission recent activity does). */
  readonly showAuditLink = input(true);

  protected readonly rows = computed(() => {
    const now = Date.now();
    return this.items().map((a) => {
      const role = roleLabel(a.actor_role);
      const actor = a.actor_name || 'System';
      return {
        id: a.id,
        icon: activityIcon(a.action),
        summary: a.summary || a.label,
        // "Ada Admin · Super admin"; the system acting is just "System".
        actor: role && a.actor_name && role.toLowerCase() !== actor.toLowerCase() ? `${actor} · ${role}` : actor,
        at: a.created_at,
        ago: relativeTime(a.created_at, now) || dateTime(a.created_at),
        exact: dateTime(a.created_at),
        link: a.link,
      };
    });
  });
}
