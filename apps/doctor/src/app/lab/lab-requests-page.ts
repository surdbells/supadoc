import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { LabRequestsApi } from '@supadoc/data-access';
import type { LabListGroup, LabRequestSummaryDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { debounceTime, Subject, type Subscription } from 'rxjs';
import { DoctorClock } from '../doctor-clock';
import { LabSelect } from './lab-select';
import {
  ageSex,
  countLabel,
  LAB_GROUPS,
  LAB_PRIORITY_META,
  labDayLabel,
  labStatusMeta,
  showsAbnormalCaption,
} from './lab-ui';
import { DocPrescriptionsLabHeader } from './prescriptions-lab-header';

const PER_PAGE = 20;
const Q_MAX = 100;
const LOAD_ERROR = 'Could not load your lab requests. Please try again.';

/** Laboratory & Diagnostics list (route `/prescriptions/labs`): my requests, filter, search, open one. */
@Component({
  selector: 'doc-lab-requests-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, LabSelect, DocPrescriptionsLabHeader],
  host: { class: 'block' },
  styles: `
    .lr-shimmer {
      height: 91px;
    }
    @media (min-width: 64rem) {
      .lr-date {
        width: 116px;
      }
      /* "Result ready · Abnormal" on one line (139 px wrapped it). */
      .lr-status {
        width: 184px;
      }
    }
    @media (min-width: 40rem) {
      .lr-search {
        flex: 1 1 16rem;
        min-width: 0;
      }
    }
    @media (min-width: 80rem) {
      /* Wide enough for the whole 12 px placeholder (220 px cut it at "request ID,"). */
      .lr-search {
        flex: none;
        width: 264px;
      }
      .lr-filter {
        width: 180px;
      }
    }
    .lr-card {
      border-radius: 24px;
    }
    /*
     * Name | age · sex  priority. The divider sits in the gap before the age/sex
     * group; when the group wraps under the name it starts 17 px left of the
     * clipping box, so its divider is cut off instead of dangling.
     */
    .lr-row {
      margin-left: -17px;
    }
    .lr-name {
      margin-left: 17px;
    }
    .lr-sep {
      position: relative;
      padding-left: 17px;
    }
    .lr-sep::before {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      width: 1px;
      height: 16px;
      margin-top: -8px;
      background: var(--color-ash);
    }
    .lr-right {
      column-gap: 40px;
      row-gap: 12px;
    }
    /* 1024–1279: tighter gaps pay for the wider status column, so the name column keeps its room. */
    @media (min-width: 64rem) {
      .lr-card {
        gap: 24px;
      }
      .lr-right {
        column-gap: 24px;
      }
    }
    @media (min-width: 80rem) {
      .lr-card {
        gap: 40px;
      }
      .lr-right {
        column-gap: 40px;
      }
    }
  `,
  template: `
    <div class="flex flex-col gap-10 py-2">
      <doc-prescriptions-lab-header active="labs" />

      <div class="flex flex-col gap-10">
        <div class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div class="flex flex-col gap-1">
            <h2 class="font-sans text-h5 font-semibold text-ink">Laboratory &amp; Diagnostics</h2>
            <p class="font-sans text-caption text-slate">
              Track investigation requests and results across your patients, or start a new one
            </p>
          </div>
          <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div class="lr-search relative">
              <sd-icon name="search" [size]="16" class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate" />
              <input
                type="search"
                autocomplete="off"
                aria-label="Search lab requests"
                placeholder="Search patient, request ID, test..."
                class="h-12 w-full rounded-[24px] border-[0.5px] border-ash bg-white pl-10 pr-4 font-sans text-caption text-ink placeholder:text-slate focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20"
                [maxLength]="qMax"
                [value]="q()"
                (input)="onSearch($any($event.target).value)"
              />
            </div>
            <doc-lab-select
              class="lr-filter"
              id="lab-status-filter"
              variant="pill"
              [placeholderRow]="false"
              [options]="groupOptions"
              [value]="group()"
              [ariaLabel]="'Status filter: ' + groupLabel()"
              [badge]="group() === 'all' ? null : (counts()?.[group()] ?? null)"
              (valueChange)="setGroup($any($event))"
            />
            <a
              routerLink="/prescriptions/labs/new"
              class="inline-flex h-12 items-center justify-center gap-2 rounded-field bg-cerulean px-4 py-3 font-sans text-body-sm font-medium text-white shadow-btn transition hover:bg-cerulean-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
            >
              <sd-icon name="plus" [size]="24" /> New Request
            </a>
          </div>
        </div>

        <p class="sr-only" role="status">{{ announce() }}</p>

        @if (loading() && items().length === 0) {
          <div class="flex flex-col gap-4" aria-busy="true">
            <span class="sr-only">Loading lab requests…</span>
            <div class="lr-shimmer sd-shimmer rounded-[24px]"></div>
            <div class="lr-shimmer sd-shimmer rounded-[24px]"></div>
            <div class="lr-shimmer sd-shimmer rounded-[24px]"></div>
          </div>
        } @else if (error() && items().length === 0) {
          <div class="flex flex-col items-center gap-3 rounded-card border border-haze bg-white px-4 py-16 text-center shadow-card">
            <sd-icon name="wifi-off" [size]="32" class="text-alert" />
            <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-field border border-haze bg-white px-4 py-2 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean"
              (click)="reload()"
            >
              <sd-icon name="refresh-cw" [size]="16" /> Try again
            </button>
          </div>
        } @else if (items().length === 0) {
          @if (q().trim()) {
            <p class="py-16 text-center font-sans text-body-sm text-slate">No requests match “{{ q().trim() }}”.</p>
          } @else if (group() !== 'all') {
            <p class="py-16 text-center font-sans text-body-sm text-slate">No requests in this filter.</p>
          } @else {
            <div class="flex flex-col items-center gap-4 py-16 text-center">
              <span class="flex size-20 items-center justify-center rounded-full bg-cloud/60 text-slate">
                <sd-icon name="microscope" [size]="34" />
              </span>
              <p class="font-sans text-body text-ink">No investigation requests yet</p>
              <a
                routerLink="/prescriptions/labs/new"
                class="inline-flex h-12 items-center justify-center gap-2 rounded-field bg-cerulean px-4 py-3 font-sans text-body-sm font-medium text-white shadow-btn transition hover:bg-cerulean-dark"
              >
                <sd-icon name="plus" [size]="24" /> New Request
              </a>
            </div>
          }
        } @else {
          <ul class="flex flex-col gap-4">
            @for (r of items(); track r.id) {
              @let chip = chipOf(r);
              <li>
                <a
                  [routerLink]="['/prescriptions/labs', r.id]"
                  class="lr-card flex flex-col gap-4 border-[0.5px] border-haze bg-white px-6 py-4 shadow-card transition hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 lg:flex-row lg:items-center"
                >
                  <div class="flex min-w-0 flex-1 items-center gap-5">
                    <span class="flex size-14 shrink-0 items-center justify-center rounded-full bg-cerulean/10 text-cerulean-dark" aria-hidden="true">
                      <sd-icon name="microscope" [size]="24" />
                    </span>
                    <div class="flex min-w-0 flex-1 flex-col gap-1">
                      @let meta = ageSexOf(r);
                      <span class="block min-w-0 overflow-hidden">
                        <span class="flex flex-wrap items-center gap-x-4 gap-y-1" [class.lr-row]="!!meta">
                          <span class="min-w-0 truncate font-sans text-body-lg text-ink" [class.lr-name]="!!meta">{{ r.patient.name }}</span>
                          @if (meta) {
                            <span class="lr-sep flex flex-wrap items-center gap-x-4 gap-y-1">
                              <span class="font-sans text-body-sm text-slate">{{ meta }}</span>
                              <span class="font-sans text-body-sm font-medium" [class]="priority(r).cls">{{ priority(r).label }}</span>
                            </span>
                          } @else {
                            <span class="font-sans text-body-sm font-medium" [class]="priority(r).cls">{{ priority(r).label }}</span>
                          }
                        </span>
                      </span>
                      <span class="truncate font-sans text-body-sm text-slate">{{ line2(r) }}</span>
                    </div>
                  </div>
                  <div class="lr-right flex flex-wrap items-center">
                    <div class="lr-date flex flex-col gap-1">
                      <span class="flex items-center gap-2 font-sans text-body-sm text-slate">
                        <sd-icon name="calendar-days" [size]="20" />{{ day(r.sent_at) }}
                      </span>
                      <span class="flex items-center gap-2 font-sans text-body text-slate">
                        <sd-icon name="clock" [size]="20" />{{ clock.time(r.sent_at) }}
                      </span>
                    </div>
                    <div class="lr-status flex flex-col items-start gap-1">
                      <span class="inline-flex whitespace-nowrap rounded-xl px-4 py-1.5 font-sans text-caption font-medium" [class]="chip.cls">{{ chip.label }}</span>
                      @if (r.unreviewed_count > 0) {
                        <span class="font-sans text-caption font-medium text-alert-ink">Needs review</span>
                      }
                      @if (abnormalCaption(r)) {
                        <span class="font-sans text-caption font-medium text-alert-ink">Abnormal result</span>
                      }
                    </div>
                    <sd-icon name="chevron-right" [size]="24" class="hidden shrink-0 text-slate lg:block" />
                  </div>
                </a>
              </li>
            }
          </ul>

          @if (error()) {
            <p class="text-center font-sans text-caption text-alert-ink" role="alert">{{ error() }}</p>
          }
          @if (hasMore()) {
            <button
              type="button"
              class="mx-auto rounded-field border border-haze bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean disabled:opacity-60"
              [disabled]="loading()"
              (click)="loadMore()"
            >
              {{ loading() ? 'Loading…' : 'Load more' }}
            </button>
          }
        }
      </div>
    </div>
  `,
})
export class LabRequestsPage implements OnInit {
  /** The doctor's clock (their profile time zone): every time shown here. */
  protected readonly clock = inject(DoctorClock);
  private readonly api = inject(LabRequestsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly qMax = Q_MAX;
  protected readonly groupOptions = LAB_GROUPS.map((g) => ({ value: g.key, label: g.label }));
  protected readonly group = signal<LabListGroup>('all');
  protected readonly q = signal('');
  protected readonly items = signal<LabRequestSummaryDto[]>([]);
  protected readonly counts = signal<Record<LabListGroup, number> | null>(null);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);
  protected readonly error = signal('');
  protected readonly announce = signal('');
  protected readonly groupLabel = computed(() => LAB_GROUPS.find((g) => g.key === this.group())?.label ?? 'All');

  private page = 1;
  private sub: Subscription | null = null;
  private readonly search$ = new Subject<void>();

  constructor() {
    this.search$.pipe(debounceTime(300), takeUntilDestroyed()).subscribe(() => this.reload());
  }

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => this.sub?.unsubscribe());
    this.fetch();
  }

  protected setGroup(g: LabListGroup): void {
    if (g === this.group()) return;
    this.group.set(g);
    this.reload();
  }

  protected onSearch(value: string): void {
    this.q.set(value.slice(0, Q_MAX));
    this.search$.next();
  }

  protected reload(): void {
    this.page = 1;
    this.fetch();
  }

  protected loadMore(): void {
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    const page = this.page;
    this.sub = this.api
      .list({ group: this.group(), q: this.q().trim() || undefined, page, per_page: PER_PAGE })
      .subscribe({
        next: (res) => {
          this.items.update((list) => (page === 1 ? res.data : [...list, ...res.data]));
          this.counts.set(res.meta?.counts ?? null);
          this.hasMore.set(!!res.meta && res.meta.page < res.meta.total_pages);
          this.loading.set(false);
          this.announce.set(countLabel(res.meta?.total ?? res.data.length, 'request'));
        },
        error: () => {
          if (this.page > 1) this.page -= 1;
          if (page === 1) this.items.set([]);
          this.error.set(LOAD_ERROR);
          this.loading.set(false);
        },
      });
  }

  protected chipOf(r: LabRequestSummaryDto) {
    return labStatusMeta(r);
  }

  protected abnormalCaption(r: LabRequestSummaryDto): boolean {
    return showsAbnormalCaption(r);
  }

  protected priority(r: LabRequestSummaryDto) {
    return LAB_PRIORITY_META[r.priority] ?? LAB_PRIORITY_META.routine;
  }

  protected ageSexOf(r: LabRequestSummaryDto): string {
    return ageSex(r.patient.age, r.patient.sex);
  }

  /** "{number} · {clinical_question} · {tests_label}". */
  protected line2(r: LabRequestSummaryDto): string {
    return [r.number, r.clinical_question, r.tests_label].filter((p) => !!p && p.trim()).join(' · ');
  }

  protected day(iso: string): string {
    return labDayLabel(iso, this.clock);
  }
}
