import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Params, Router, RouterLink } from '@angular/router';
import type { Subscription } from 'rxjs';
import { AdminDoctorApplicationsApi, apiErrorMessage } from '@supadoc/data-access';
import type {
  DoctorApplicationFilter,
  DoctorApplicationRowDto,
  DoctorApplicationSort,
  LicenceRoute,
} from '@supadoc/models';
import { EmptyStateComponent, IconComponent } from '@supadoc/ui';
import {
  AVATAR,
  BTN_SECONDARY,
  CARD_ITEM,
  CARD_LIST,
  CARD_ROW,
  CHIP,
  COUNT_BADGE,
  EMPTY_FRAME,
  FIELD_ICON,
  FIELD_WITH_ICON,
  FILTER_CHIP,
  FILTER_CHIP_HOT,
  FILTER_CHIP_OFF,
  FILTER_CHIP_ON,
  FILTER_CHIPS,
  FOCUS_RING,
  PAGE,
  PAGE_HEADER,
  PAGE_HEADER_TEXT,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  PAGE_TITLE_ROW,
  PAGER,
  PAGER_GAP,
  PAGER_PAGE,
  PAGER_PAGE_OFF,
  PAGER_PAGE_ON,
  PAGER_PAGES,
  PAGER_SUMMARY,
  PILL,
  SEARCH_BOX,
  SEARCH_CLEAR,
  SEARCH_ICON,
  SEARCH_INPUT,
  SEARCH_WRAP,
  SEGMENT,
  SEGMENT_OFF,
  SEGMENT_ON,
  SEGMENTED,
} from '../shared/layout';
import { pageWindow } from '../shared/pager';
import { type Badge, dateOnly, initials, plural } from '../specialists/specialist-ui';
import {
  APPLICATION_FILTERS,
  APPLICATION_SORTS,
  applicationStatusBadge,
  clinicDateTime,
  defaultSort,
  NEEDS_ACTION_BADGE,
  ROUTE_OPTIONS,
  routeBadge,
} from './application-ui';
import { ApplicationsQueue } from './applications-queue';

const PER_PAGE = 20;

interface ListState {
  q: string;
  filter: DoctorApplicationFilter;
  route: LicenceRoute | '';
  /** '' = the API's default for the filter. */
  sort: DoctorApplicationSort | '';
  page: number;
}

/** The list's URL query (?q=&filter=&route=&sort=&page=), defaults left out. */
export function listParams(s: ListState): Params {
  const p: Params = {};
  const q = s.q.trim();
  if (q) p['q'] = q;
  if (s.filter !== 'all') p['filter'] = s.filter;
  if (s.route) p['route'] = s.route;
  if (s.sort) p['sort'] = s.sort;
  if (s.page > 1) p['page'] = s.page;
  return p;
}

/** A comparable form of a list query, to tell our own URL writes from real changes. */
function urlKey(s: ListState): string {
  return JSON.stringify(listParams(s));
}

/**
 * Doctor applications (route `/applications`, needs `specialists.manage`) —
 * the review queue, paged on the server: a status filter (with the queue's
 * counts; "Needs action" highlighted while anything waits), the licence route,
 * a sort and a search, all in the URL (the dashboard links straight to
 * `?filter=needs_action`). Drafts are never listed. Each row opens the
 * application, carrying the list's query so "Back" returns to it.
 */
@Component({
  selector: 'bo-applications',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, EmptyStateComponent],
  host: { class: 'block' },
  template: `
    <div class="${PAGE}">
      <header class="${PAGE_HEADER}">
        <div class="${PAGE_HEADER_TEXT}">
          <div class="${PAGE_TITLE_ROW}">
            <h1 class="${PAGE_TITLE}">Doctor applications</h1>
            @if (allTotal(); as n) {
              <span class="${COUNT_BADGE}">
                <sd-icon name="clipboard-list" [size]="14" />{{ plural(n, 'application') }}
              </span>
            }
          </div>
          <p class="${PAGE_SUBTITLE}">Review doctors who applied to join, ask for what's missing, interview and approve.</p>
        </div>
      </header>

      <div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div role="search" class="${SEARCH_WRAP}">
          <label for="bo-applications-search" class="sr-only">Search name, email, phone, reference or licence number</label>
          <div class="${SEARCH_BOX}">
            <sd-icon name="search" [size]="20" class="${SEARCH_ICON}" />
            <input
              id="bo-applications-search"
              type="search"
              autocomplete="off"
              spellcheck="false"
              enterkeyhint="search"
              class="${SEARCH_INPUT}"
              placeholder="Search name, email, phone, reference or licence number"
              [value]="search()"
              (input)="onSearch($any($event.target).value)"
              (keydown.escape)="search() && onSearch('')"
            />
            @if (search()) {
              <button type="button" class="${SEARCH_CLEAR}" aria-label="Clear search" (click)="onSearch('')">
                <sd-icon name="x" [size]="16" />
              </button>
            }
          </div>
        </div>
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div class="${SEGMENTED}" role="group" aria-label="Where they are licensed">
            @for (r of routes; track r.value) {
              <button
                type="button"
                class="${SEGMENT}"
                [class]="route() === r.value ? '${SEGMENT_ON}' : '${SEGMENT_OFF}'"
                [attr.aria-pressed]="route() === r.value"
                (click)="setRoute(r.value)"
              >{{ r.label }}</button>
            }
          </div>
          <label class="relative block sm:hidden">
            <span class="sr-only">Show</span>
            <sd-icon name="filter" [size]="20" class="${FIELD_ICON}" />
            <select class="${FIELD_WITH_ICON}" (change)="setFilter($any($event.target).value)">
              @for (f of filterChips(); track f.value) {
                <option [value]="f.value" [selected]="f.value === filter()">{{ f.label }}{{ f.count !== null ? ' (' + f.count + ')' : '' }}</option>
              }
            </select>
          </label>
          <label class="relative block sm:w-56">
            <span class="sr-only">Sort by</span>
            <sd-icon name="arrow-up-down" [size]="20" class="${FIELD_ICON}" />
            <select class="${FIELD_WITH_ICON}" (change)="setSort($any($event.target).value)">
              @for (s of sorts; track s.value) {
                <option [value]="s.value" [selected]="s.value === effectiveSort()">{{ s.label }}</option>
              }
            </select>
          </label>
        </div>
      </div>

      <div class="hidden ${FILTER_CHIPS} sm:flex" role="group" aria-label="Filter applications">
        @for (f of filterChips(); track f.value) {
          <button
            type="button"
            [attr.aria-pressed]="filter() === f.value"
            class="${FILTER_CHIP}"
            [class]="filter() === f.value ? '${FILTER_CHIP_ON}' : (f.hot ? '${FILTER_CHIP_HOT}' : '${FILTER_CHIP_OFF}')"
            (click)="setFilter(f.value)"
          >
            @if (filter() === f.value) {
              <sd-icon name="check" [size]="14" />
            }
            {{ f.label }}
            @if (f.count !== null) {
              <span class="rounded-pill px-1.5 text-caption font-semibold" [class]="filter() === f.value ? 'bg-white/20' : (f.hot ? 'bg-warning/20' : 'bg-glacier')">{{ f.count }}</span>
            }
          </button>
        }
      </div>

      <p #summary tabindex="-1" class="font-sans text-body-sm text-slate focus:outline-none" aria-live="polite">
        @if (loading()) {
          Loading applications…
        } @else if (!listError()) {
          {{ summaryText() }}
        }
      </p>

      @if (loading() && rows().length === 0) {
        <div class="${CARD_LIST}" aria-hidden="true">
          @for (i of [1, 2, 3]; track i) {
            <div class="${CARD_ITEM} sm:flex-row sm:items-center">
              <div class="flex min-w-0 flex-1 items-center gap-3">
                <div class="sd-shimmer size-12 shrink-0 rounded-full"></div>
                <div class="flex min-w-0 flex-1 flex-col gap-2">
                  <div class="sd-shimmer h-4 w-40 max-w-full rounded-pill"></div>
                  <div class="sd-shimmer h-3 w-56 max-w-full rounded-pill"></div>
                </div>
              </div>
              <div class="sd-shimmer h-6 w-40 rounded-pill"></div>
            </div>
          }
        </div>
      } @else if (listError()) {
        <div class="${EMPTY_FRAME}">
          <sd-empty-state icon="wifi-off" tone="error" title="Couldn't load applications" [message]="listError()">
            <button type="button" class="${BTN_SECONDARY}" (click)="fetch()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
          </sd-empty-state>
        </div>
      } @else {
        <ul class="${CARD_LIST}" [attr.aria-busy]="loading() || null" [class.opacity-60]="loading()">
          @for (r of rows(); track r.id) {
            <li>
              <a
                [routerLink]="['/applications', r.id]"
                [state]="{ listQuery: queryParams() }"
                class="${CARD_ROW} sm:flex-row sm:items-center sm:gap-6 ${FOCUS_RING}"
              >
                <span class="flex min-w-0 flex-1 items-center gap-3">
                  <span class="${AVATAR}" aria-hidden="true">{{ initials(r.full_name) }}</span>
                  <span class="flex min-w-0 flex-col">
                    <span class="break-words font-heading text-body-lg text-ink transition-colors group-hover:text-cerulean">{{ r.full_name }}</span>
                    <span class="font-mono text-caption text-slate">{{ r.reference }}</span>
                    <span class="truncate font-sans text-body-sm text-cerulean">{{ r.specialty || 'Specialty not given' }}</span>
                  </span>
                </span>
                <span class="flex flex-col gap-1.5 sm:max-w-[60%] sm:items-end">
                  <span class="flex flex-wrap items-center gap-1.5 sm:justify-end">
                    @for (b of badgesFor(r); track b.label) {
                      <span class="${PILL}" [class]="b.cls"><sd-icon [name]="b.icon" [size]="13" />{{ b.label }}</span>
                    }
                    @let rb = routeOf(r);
                    <span class="${CHIP}" [class]="rb.cls"><sd-icon [name]="rb.icon" [size]="14" />{{ rb.label }}</span>
                  </span>
                  <span class="font-sans text-caption text-slate">{{ whenText(r) }}</span>
                </span>
                <sd-icon name="chevron-right" [size]="22" class="hidden shrink-0 text-slate transition-colors group-hover:text-cerulean sm:block" />
              </a>
            </li>
          } @empty {
            <li class="${EMPTY_FRAME}">
              @if (filtered()) {
                <sd-empty-state icon="search" title="No applications match these filters." message="Try another filter or search.">
                  <button type="button" class="${BTN_SECONDARY}" (click)="clearFilters()"><sd-icon name="x" [size]="16" />Clear search and filters</button>
                </sd-empty-state>
              } @else {
                <sd-empty-state icon="clipboard-list" tone="brand" title="No applications yet" message="Doctors' applications appear here once they submit them." />
              }
            </li>
          }
        </ul>

        @if (totalPages() > 1) {
          <nav class="${PAGER}" aria-label="Application pages">
            <button type="button" class="${BTN_SECONDARY}" [disabled]="page() <= 1 || loading()" (click)="goPage(page() - 1)">
              <sd-icon name="chevron-left" [size]="18" />Previous
            </button>
            <ol class="${PAGER_PAGES}">
              @for (p of pages(); track $index) {
                @if (p === 0) {
                  <li class="${PAGER_GAP}" aria-hidden="true">…</li>
                } @else {
                  <li>
                    <button
                      type="button"
                      class="${PAGER_PAGE}"
                      [class]="p === page() ? '${PAGER_PAGE_ON}' : '${PAGER_PAGE_OFF}'"
                      [attr.aria-current]="p === page() ? 'page' : null"
                      [attr.aria-label]="'Page ' + p"
                      [disabled]="loading()"
                      (click)="goPage(p)"
                    >{{ p }}</button>
                  </li>
                }
              }
            </ol>
            <span class="${PAGER_SUMMARY}">Page {{ page() }} of {{ totalPages() }}</span>
            <button type="button" class="${BTN_SECONDARY}" [disabled]="page() >= totalPages() || loading()" (click)="goPage(page() + 1)">
              Next<sd-icon name="chevron-right" [size]="18" />
            </button>
          </nav>
        }
      }
    </div>
  `,
})
export class AdminApplications implements OnInit {
  private readonly api = inject(AdminDoctorApplicationsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route$ = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly queue = inject(ApplicationsQueue);

  protected readonly sorts = APPLICATION_SORTS;
  protected readonly routes = ROUTE_OPTIONS;
  protected readonly plural = plural;
  protected readonly initials = initials;
  /** Every application (the header badge): from an unfiltered page, or one tiny unfiltered read. */
  protected readonly allTotal = signal<number | null>(null);
  private countSub?: Subscription;

  // List state (mirrored in the URL)
  protected readonly search = signal('');
  protected readonly filter = signal<DoctorApplicationFilter>('all');
  protected readonly route = signal<LicenceRoute | ''>('');
  protected readonly sort = signal<DoctorApplicationSort | ''>('');
  protected readonly page = signal(1);
  protected readonly rows = signal<DoctorApplicationRowDto[]>([]);
  protected readonly total = signal(0);
  protected readonly totalPages = signal(1);
  protected readonly pages = computed(() => pageWindow(this.page(), this.totalPages()));
  protected readonly loading = signal(true);
  protected readonly listError = signal('');
  private listSub?: Subscription;
  private urlState = '';
  private searchTimer?: ReturnType<typeof setTimeout>;
  private readonly summaryEl = viewChild<ElementRef<HTMLElement>>('summary');

  /** The sort the API applies: the chosen one, else the filter's default. */
  protected readonly effectiveSort = computed(() => this.sort() || defaultSort(this.filter()));

  protected readonly filterChips = computed(() => {
    const counts = this.queue.counts();
    return APPLICATION_FILTERS.map((f) => {
      const count = f.count && counts ? Math.max(0, Number(counts[f.count]) || 0) : null;
      return { ...f, count, hot: !!f.attention && (count ?? 0) > 0 };
    });
  });

  protected readonly filtered = computed(() => this.search().trim() !== '' || this.filter() !== 'all' || this.route() !== '');

  protected readonly summaryText = computed(() => {
    const what = plural(this.total(), 'application');
    const parts = [what];
    if (this.filter() !== 'all') parts.push(APPLICATION_FILTERS.find((f) => f.value === this.filter())?.label ?? '');
    if (this.route()) parts.push(this.route() === 'abroad' ? 'Licensed abroad' : 'Licensed in Nigeria');
    const q = this.search().trim();
    return parts.join(' · ') + (q ? ` matching “${q}”` : '');
  });

  /** The list's query params, carried to the application page so "Back" returns here. */
  protected readonly queryParams = computed<Params>(() => listParams(this.listState()));

  private listState(): ListState {
    return { q: this.search(), filter: this.filter(), route: this.route(), sort: this.sort(), page: this.page() };
  }

  ngOnInit(): void {
    // The URL drives the list: on arrival (a dashboard link: ?filter=needs_action)
    // and whenever it changes while the list is open. Our own URL writes are skipped.
    this.route$.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((qp) => {
      const filter = qp.get('filter') as DoctorApplicationFilter | null;
      const route = qp.get('route');
      const sort = qp.get('sort') as DoctorApplicationSort | null;
      const page = Number(qp.get('page'));
      const next: ListState = {
        q: qp.get('q') ?? '',
        filter: filter && APPLICATION_FILTERS.some((f) => f.value === filter) ? filter : 'all',
        route: route === 'ng' || route === 'abroad' ? route : '',
        sort: sort && APPLICATION_SORTS.some((s) => s.value === sort) ? sort : '',
        page: Number.isInteger(page) && page > 1 ? page : 1,
      };
      if (this.urlState !== '' && urlKey(next) === this.urlState) return;
      this.search.set(next.q);
      this.filter.set(next.filter);
      this.route.set(next.route);
      this.sort.set(next.sort);
      this.page.set(next.page);
      this.urlState = urlKey(next);
      this.fetch();
    });
  }

  protected onSearch(term: string): void {
    this.search.set(term);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page.set(1);
      this.fetch();
    }, 300);
  }

  protected setFilter(value: string): void {
    if (!APPLICATION_FILTERS.some((f) => f.value === value)) return;
    this.filter.set(value as DoctorApplicationFilter);
    this.page.set(1);
    this.fetch();
  }

  protected setRoute(value: LicenceRoute | ''): void {
    this.route.set(value);
    this.page.set(1);
    this.fetch();
  }

  protected setSort(value: string): void {
    if (!APPLICATION_SORTS.some((s) => s.value === value)) return;
    this.sort.set(value as DoctorApplicationSort);
    this.page.set(1);
    this.fetch();
  }

  protected clearFilters(): void {
    this.search.set('');
    this.filter.set('all');
    this.route.set('');
    this.page.set(1);
    this.fetch();
  }

  protected goPage(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.page.set(page);
    this.fetch(true);
  }

  /** Load the current page (and mirror the state in the URL). */
  protected fetch(moveFocus = false): void {
    clearTimeout(this.searchTimer);
    this.syncUrl();
    this.listSub?.unsubscribe();
    this.loading.set(true);
    this.listError.set('');
    const q = this.search().trim();
    const unfiltered = this.filter() === 'all' && this.route() === '' && q === '';
    this.listSub = this.api
      .list({
        q: q || undefined,
        filter: this.filter() === 'all' ? undefined : this.filter(),
        route: this.route() || undefined,
        sort: this.sort() || undefined,
        page: this.page(),
        per_page: PER_PAGE,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.rows.set(res.data ?? []);
          this.total.set(res.meta?.total ?? res.data.length);
          if (unfiltered) {
            this.countSub?.unsubscribe();
            this.allTotal.set(this.total());
          } else if (this.allTotal() === null && (this.countSub?.closed ?? true)) {
            this.countAll();
          }
          this.totalPages.set(Math.max(1, res.meta?.total_pages ?? 1));
          this.loading.set(false);
          // A page past the end (e.g. an old link): go to the last one.
          if (this.page() > this.totalPages()) {
            this.page.set(this.totalPages());
            this.fetch();
            return;
          }
          if (moveFocus) {
            afterNextRender(() => this.summaryEl()?.nativeElement.focus(), { injector: this.injector });
          }
        },
        error: (err: unknown) => {
          this.listError.set(apiErrorMessage(err, 'Could not load applications.'));
          this.loading.set(false);
        },
      });
  }

  /** How many applications there are in all (the header badge), for a list that is filtered or searched. */
  private countAll(): void {
    this.countSub?.unsubscribe();
    this.countSub = this.api
      .list({ page: 1, per_page: 1 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const n = res.meta?.total;
          if (typeof n === 'number') this.allTotal.set(n);
        },
        // The badge is a nicety: without it the page still works.
        error: () => undefined,
      });
  }

  /** Mirror the state in the URL — unless it already says this (e.g. it was just read from it). */
  private syncUrl(): void {
    const key = urlKey(this.listState());
    if (key === this.urlState) return;
    this.urlState = key;
    void this.router.navigate([], {
      relativeTo: this.route$,
      queryParams: this.queryParams(),
      replaceUrl: true,
    });
  }

  /** Status, and "Needs action" while it waits for staff — icon + words each. */
  protected badgesFor(r: DoctorApplicationRowDto): Badge[] {
    const out: Badge[] = [applicationStatusBadge(r.status)];
    if (r.awaiting_staff) out.push(NEEDS_ACTION_BADGE);
    return out;
  }

  protected routeOf(r: DoctorApplicationRowDto): Badge {
    return routeBadge(r.licence_route, r.licence_label);
  }

  /** "Submitted 7 Oct 2026", or "Interview Wed 14 Oct, 10:00 WAT" once one is booked. */
  protected whenText(r: DoctorApplicationRowDto): string {
    if (r.status === 'interview_scheduled' && r.interview_starts_at) return `Interview ${clinicDateTime(r.interview_starts_at)}`;
    return `Submitted ${dateOnly(r.submitted_at)}`;
  }
}
