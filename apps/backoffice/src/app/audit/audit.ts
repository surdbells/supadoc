import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, MonitoringApi } from '@supadoc/data-access';
import type { AuditEventDto } from '@supadoc/models';
import { EmptyStateComponent, IconComponent } from '@supadoc/ui';
import {
  BTN_BESIDE_FIELD,
  BTN_SECONDARY,
  EMPTY_FRAME,
  INLINE_ERROR,
  LOAD_MORE,
  PAGE,
  PAGE_HEADER_TEXT,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  SEARCH_BOX,
  SEARCH_CLEAR,
  SEARCH_ICON,
  SEARCH_INPUT,
  SEARCH_WRAP,
  TABLE,
  TABLE_WRAP,
  TBODY,
  TD,
  TD_PRIMARY,
  TH,
  THEAD,
  TR,
} from '../shared/layout';

/** Audit trail (route `/audit`) — every recorded staff/patient action. */
@Component({
  selector: 'bo-audit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, EmptyStateComponent],
  host: { class: 'block' },
  template: `
    <div class="${PAGE}">
      <header class="${PAGE_HEADER_TEXT}">
        <h1 class="${PAGE_TITLE}">Audit log</h1>
        <p class="${PAGE_SUBTITLE}">A record of actions across the platform.</p>
      </header>

      <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div role="search" class="${SEARCH_WRAP}">
          <label for="bo-audit-filter" class="sr-only">Filter by action</label>
          <div class="${SEARCH_BOX}">
            <sd-icon name="search" [size]="20" class="${SEARCH_ICON}" />
            <input
              id="bo-audit-filter"
              type="search"
              autocomplete="off"
              spellcheck="false"
              enterkeyhint="search"
              class="${SEARCH_INPUT}"
              placeholder="Filter by action (e.g. wallet.topup)"
              [value]="actionFilter()"
              (input)="actionFilter.set($any($event.target).value)"
              (keydown.enter)="apply()"
            />
            @if (actionFilter()) {
              <button type="button" class="${SEARCH_CLEAR}" aria-label="Clear filter" (click)="actionFilter.set(''); apply()">
                <sd-icon name="x" [size]="16" />
              </button>
            }
          </div>
        </div>
        <button type="button" class="${BTN_SECONDARY} ${BTN_BESIDE_FIELD} shrink-0" (click)="apply()"><sd-icon name="filter" [size]="16" />Filter</button>
      </div>

      @if (events().length === 0) {
        @if (loading()) {
          <div class="${TABLE_WRAP} flex flex-col divide-y divide-cloud" aria-busy="true">
            <span class="sr-only">Loading audit events…</span>
            @for (i of [1, 2, 3, 4]; track i) {
              <div class="flex items-center gap-4 px-5 py-4" aria-hidden="true">
                <div class="sd-shimmer h-4 w-40 max-w-full rounded-pill"></div>
                <div class="sd-shimmer h-4 w-28 rounded-pill"></div>
                <div class="sd-shimmer ml-auto h-4 w-24 rounded-pill"></div>
              </div>
            }
          </div>
        } @else if (loadError()) {
          <div class="${EMPTY_FRAME}" role="alert">
            <sd-empty-state icon="wifi-off" tone="error" title="Couldn't load the audit log" [message]="loadError()">
              <button type="button" class="${BTN_SECONDARY}" (click)="apply()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
            </sd-empty-state>
          </div>
        } @else {
          <sd-empty-state icon="history" title="No audit events" [message]="appliedFilter() ?'Nothing recorded for that action. Try another filter.' : 'Actions across the platform are recorded here.'" />
        }
      } @else {
        <div class="${TABLE_WRAP}">
          <table class="${TABLE} min-w-[640px]">
            <thead class="${THEAD}">
              <tr>
                <th class="${TH}">Action</th>
                <th class="${TH}">Actor</th>
                <th class="${TH}">Role</th>
                <th class="${TH}">Resource</th>
                <th class="${TH}">When</th>
              </tr>
            </thead>
            <tbody class="${TBODY}">
              @for (a of events(); track a.id) {
                <tr class="${TR}">
                  <td class="${TD} font-mono text-caption">{{ a.action }}</td>
                  <td class="${TD} ${TD_PRIMARY}">{{ a.actor_name }}</td>
                  <td class="${TD} capitalize text-slate">{{ a.actor_role }}</td>
                  <td class="${TD} text-slate">{{ a.resource_type || '—' }}</td>
                  <td class="${TD} text-slate">{{ when(a.created_at) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if ((loadError() && events().length > 0) || hasMore()) {
          <div class="${LOAD_MORE}">
            @if (loadError() && events().length > 0) {
              <p class="${INLINE_ERROR}" role="alert"><sd-icon name="circle-alert" [size]="16" class="shrink-0" />{{ loadError() }}</p>
            }
            @if (hasMore()) {
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
      }
    </div>
  `,
})
export class AdminAudit implements OnInit {
  private readonly api = inject(MonitoringApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly events = signal<AuditEventDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly hasMore = signal(false);
  /** What the box says (applied on Enter, Filter or clear)… */
  protected readonly actionFilter = signal('');
  /** …and the filter the shown events were loaded with (Load more keeps it). */
  protected readonly appliedFilter = signal('');
  private page = 1;

  ngOnInit(): void {
    this.fetch();
  }

  protected apply(): void {
    this.appliedFilter.set(this.actionFilter().trim());
    this.page = 1;
    this.events.set([]);
    this.fetch();
  }

  protected loadMore(): void {
    if (this.loading()) return;
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    this.loadError.set('');
    const action = this.appliedFilter() || undefined;
    this.api
      .audit({ page: this.page, per_page: 40, action })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.events.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          if (this.page > 1) this.page -= 1;
          this.loadError.set(apiErrorMessage(err, 'Could not load the audit log.'));
          this.loading.set(false);
        },
      });
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
  }
}
