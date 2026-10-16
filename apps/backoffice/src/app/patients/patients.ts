import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { AdminPatientsApi, apiErrorMessage } from '@supadoc/data-access';
import type { PatientAccountDto } from '@supadoc/models';
import { EmptyStateComponent, IconComponent } from '@supadoc/ui';
import {
  AVATAR,
  BTN_SECONDARY,
  COUNT_BADGE,
  EMPTY_FRAME,
  INLINE_ERROR,
  LIST_BODY,
  LIST_FRAME,
  LIST_HEAD,
  LIST_ROW,
  LOAD_MORE,
  LOAD_MORE_NOTE,
  PAGE,
  PAGE_HEADER_TEXT,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  PAGE_TITLE_ROW,
  ROW_CHEVRON,
  ROW_CHEVRON_ICON,
  ROW_END,
  ROW_LINK,
  ROW_META,
  ROW_METAS,
  ROW_SUB,
  ROW_TEXT,
  ROW_TITLE,
  SEARCH_BOX,
  SEARCH_CLEAR,
  SEARCH_ICON,
  SEARCH_INPUT,
  SEARCH_RESULTS,
  SEARCH_ROW,
  SEARCH_WRAP,
} from '../shared/layout';

/** Desktop column template, shared by the header and every row: Patient | Phone | Joined | chevron. */
const COLUMNS = 'md:grid-cols-[minmax(0,1fr)_10rem_8rem_2.5rem] xl:grid-cols-[minmax(0,1fr)_12rem_9rem_3rem]';

/** Patient administration (route `/patients`) — browse the patient base. */
@Component({
  selector: 'bo-patients',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, EmptyStateComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="${PAGE}">
      <header class="${PAGE_HEADER_TEXT}">
        <div class="${PAGE_TITLE_ROW}">
          <h1 class="${PAGE_TITLE}">Patients</h1>
          @if (allTotal(); as n) {
            <span class="${COUNT_BADGE}"><sd-icon name="users" [size]="14" />{{ countLabel(n) }}</span>
          }
        </div>
        <p class="${PAGE_SUBTITLE}">Browse registered patients and open a record.</p>
      </header>

      <div class="${SEARCH_ROW}">
        <div role="search" class="${SEARCH_WRAP}">
          <label for="bo-patients-search" class="sr-only">Search patients by name, email or phone</label>
          <div class="${SEARCH_BOX}">
            <sd-icon name="search" [size]="20" class="${SEARCH_ICON}" />
            <input
              id="bo-patients-search"
              type="search"
              autocomplete="off"
              spellcheck="false"
              enterkeyhint="search"
              [value]="search()"
              (input)="onSearch($any($event.target).value)"
              (keydown.escape)="clearSearch()"
              placeholder="Search by name, email or phone…"
              class="${SEARCH_INPUT}"
            />
            @if (search()) {
              <button type="button" class="${SEARCH_CLEAR}" aria-label="Clear search" (click)="clearSearch()">
                <sd-icon name="x" [size]="16" />
              </button>
            }
          </div>
        </div>
        @if (search().trim() && items().length > 0 && !loading()) {
          @if (total(); as t) {
            <p class="${SEARCH_RESULTS}">
              <span class="font-semibold text-ink">{{ formatCount(t) }}</span>
              {{ t === 1 ? 'result' : 'results' }} for “{{ search().trim() }}”
            </p>
          }
        }
      </div>

      @if (loading() && items().length === 0) {
        <div class="${LIST_FRAME}" aria-busy="true">
          <span class="sr-only">Loading patients…</span>
          <ul class="${LIST_BODY}" aria-hidden="true">
            @for (i of skeletonRows; track i) {
              <li class="${LIST_ROW} ${COLUMNS}">
                <div class="flex min-w-0 items-center gap-3">
                  <div class="sd-shimmer size-12 shrink-0 rounded-full"></div>
                  <div class="flex min-w-0 flex-1 flex-col gap-2">
                    <div class="sd-shimmer h-4 w-36 max-w-full rounded-pill"></div>
                    <div class="sd-shimmer h-3 w-52 max-w-full rounded-pill"></div>
                  </div>
                </div>
                <div class="sd-shimmer h-4 w-28 rounded-pill"></div>
                <div class="sd-shimmer h-4 w-24 rounded-pill"></div>
              </li>
            }
          </ul>
        </div>
      } @else if (error() && items().length === 0) {
        <div class="${EMPTY_FRAME}" role="alert">
          <sd-empty-state icon="wifi-off" tone="error" title="Couldn't load patients" [message]="error()">
            <button type="button" class="${BTN_SECONDARY}" (click)="retry()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
          </sd-empty-state>
        </div>
      } @else if (items().length === 0) {
        @if (search().trim()) {
          <sd-empty-state icon="search" [title]="'No patients match “' + search().trim() + '”'" message="Check the spelling, or search by email address or phone number.">
            <button type="button" class="${BTN_SECONDARY}" (click)="clearSearch()"><sd-icon name="x" [size]="16" />Clear search</button>
          </sd-empty-state>
        } @else {
          <sd-empty-state icon="users" tone="brand" title="No patients yet" message="Patients appear here once they create an account." />
        }
      } @else {
        <section class="${LIST_FRAME}" aria-label="Patients">
          <div class="${LIST_HEAD} ${COLUMNS}" aria-hidden="true">
            <span>Patient</span>
            <span>Phone</span>
            <span>Joined</span>
            <span></span>
          </div>
          <ul class="${LIST_BODY}">
            @for (p of items(); track p.id) {
              <li class="${LIST_ROW} ${COLUMNS}">
                <a [routerLink]="['/patients', p.id]" class="${ROW_LINK}">
                  <span class="${AVATAR}" aria-hidden="true">{{ initialsOf(p) }}</span>
                  <span class="${ROW_TEXT}">
                    <span class="${ROW_TITLE}">{{ fullName(p) }}</span>
                    <span class="${ROW_SUB}">{{ p.email }}</span>
                  </span>
                </a>
                <div class="${ROW_METAS}">
                  <span class="${ROW_META}">
                    <sd-icon name="phone" [size]="16" class="shrink-0 text-slate" />
                    <span class="min-w-0 truncate">
                      <span class="text-slate md:sr-only">Phone </span>
                      @if (p.phone) {
                        {{ p.phone }}
                      } @else {
                        <span class="text-slate" aria-hidden="true">—</span><span class="sr-only">not given</span>
                      }
                    </span>
                  </span>
                  <span class="${ROW_META}">
                    <sd-icon name="calendar-days" [size]="16" class="shrink-0 text-slate" />
                    <span class="min-w-0"><span class="text-slate md:sr-only">Joined </span>{{ when(p.created_at) }}</span>
                  </span>
                </div>
                <span class="${ROW_END}" aria-hidden="true">
                  <span class="${ROW_CHEVRON}">
                    <span class="md:hidden">View patient</span>
                    <sd-icon name="chevron-right" [size]="20" class="${ROW_CHEVRON_ICON}" />
                  </span>
                </span>
              </li>
            }
          </ul>
        </section>

        <div class="${LOAD_MORE}">
          @if (error()) {
            <p class="${INLINE_ERROR}" role="alert"><sd-icon name="circle-alert" [size]="16" class="shrink-0" />{{ error() }}</p>
          }
          @if (hasMore()) {
            @if (total(); as t) {
              <p class="${LOAD_MORE_NOTE}">Showing {{ formatCount(items().length) }} of {{ formatCount(t) }}</p>
            }
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
    </div>
  `,
})
export class AdminPatients implements OnInit {
  private readonly api = inject(AdminPatientsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly items = signal<PatientAccountDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly hasMore = signal(false);
  protected readonly search = signal('');
  /** `meta.total` for the listed results (matches, when searching). */
  protected readonly total = signal<number | null>(null);
  /** `meta.total` of the last unfiltered load — the header's patient count. */
  protected readonly allTotal = signal<number | null>(null);
  protected readonly skeletonRows = [1, 2, 3, 4, 5];
  private page = 1;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.fetch();
  }

  protected onSearch(term: string): void {
    this.search.set(term);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page = 1;
      this.items.set([]);
      this.fetch();
    }, 250);
  }

  protected clearSearch(): void {
    if (!this.search()) return;
    this.onSearch('');
  }

  protected retry(): void {
    this.fetch();
  }

  protected loadMore(): void {
    if (this.loading()) return;
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    this.error.set('');
    const term = this.search().trim();
    this.api
      .list({ page: this.page, per_page: 25, search: term || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.total.set(res.meta.total);
          if (!term) this.allTotal.set(res.meta.total);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          if (this.page > 1) this.page -= 1;
          this.error.set(apiErrorMessage(err, 'Could not load patients. Please try again.'));
          this.loading.set(false);
        },
      });
  }

  protected fullName(p: PatientAccountDto): string {
    return `${p.first_name} ${p.last_name}`.trim() || '—';
  }

  protected initialsOf(p: PatientAccountDto): string {
    const fromName = `${p.first_name?.[0] ?? ''}${p.last_name?.[0] ?? ''}`;
    return (fromName || p.email?.[0] || '?').toUpperCase();
  }

  protected formatCount(n: number): string {
    return n.toLocaleString('en-GB');
  }

  protected countLabel(n: number): string {
    return `${this.formatCount(n)} ${n === 1 ? 'patient' : 'patients'}`;
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? '—'
      : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }
}
