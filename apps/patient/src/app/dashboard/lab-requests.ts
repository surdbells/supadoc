import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import {
  apiErrorMessage,
  LabRequestsApi,
  viewerTimeZone,
} from '@supadoc/data-access';
import type {
  LabListGroup,
  PatientLabRequestSummaryDto,
} from '@supadoc/models';
import {
  ButtonComponent,
  EmptyStateComponent,
  IconComponent,
} from '@supadoc/ui';
import {
  labChip,
  labDay,
  labDoctor,
  labHelper,
  numberParts,
  priorityLabel,
  testsLabel,
} from './lab-ui';

const PER_PAGE = 20;
const EMPTY_COUNTS: Record<LabListGroup, number> = {
  all: 0,
  awaiting_patient: 0,
  in_progress: 0,
  result_ready: 0,
};

/**
 * My lab tests (Laboratory & Diagnostics, spec §4.3) — every lab request a
 * doctor has sent the patient, most recent activity first, filtered by group
 * on the server (with every group's count). A card never names a test or the
 * reason: tapping it opens the request.
 */
@Component({
  selector: 'pat-lab-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ButtonComponent, EmptyStateComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Lab Tests</h1>
        <p class="font-sans text-body text-slate">
          Tests and scans your doctors have requested, and their results.
        </p>
      </div>

      <!-- Consultation History › Lab tests -->
      <nav
        aria-label="Consultation history sections"
        class="sd-track sd-track-tight w-full sm:w-fit"
      >
        <a
          routerLink="/dashboard/history"
          class="sd-pill sd-pill-n sd-seg-solid grow sm:flex-none"
        >
          <sd-icon name="history" [size]="16" class="hidden sm:inline-flex" />
          Consultations
        </a>
        <a
          routerLink="/dashboard/prescriptions"
          class="sd-pill sd-pill-n sd-seg-solid grow sm:flex-none"
        >
          <sd-icon name="pill" [size]="16" class="hidden sm:inline-flex" />
          Prescriptions
        </a>
        <a
          routerLink="/dashboard/lab-requests"
          aria-current="page"
          class="sd-pill sd-pill-n sd-seg-solid grow sm:flex-none"
        >
          <sd-icon
            name="flask-conical"
            [size]="16"
            class="hidden sm:inline-flex"
          />
          Lab tests
        </a>
      </nav>

      @if (counts().all > 0) {
        <!-- Status filter: wraps onto a second row on a phone (all four always in view, nothing to scroll). -->
        <div
          class="sd-track sd-track-loose sd-track-wrap flex-wrap"
          role="group"
          aria-label="Filter by status"
        >
          @for (f of filters; track f.key) {
            <button
              type="button"
              class="sd-pill sd-pill-f sd-seg"
              [attr.aria-pressed]="group() === f.key"
              (click)="setGroup(f.key)"
            >
              {{ f.label }}
              <span class="font-sans text-caption"
                >({{ counts()[f.key] }})</span
              >
            </button>
          }
        </div>
      }

      @switch (viewState()) {
        @case ('loading') {
          <div
            class="flex flex-col gap-4"
            aria-busy="true"
            aria-label="Loading lab tests"
          >
            @for (n of [1, 2, 3]; track n) {
              <div class="h-36 animate-pulse rounded-card bg-cloud"></div>
            }
          </div>
        }
        @case ('error') {
          <sd-empty-state
            tone="error"
            icon="wifi-off"
            title="Couldn't load your lab tests"
            [message]="loadError()"
          >
            <sd-button variant="outline" (click)="reload()">
              <sd-icon name="refresh-cw" [size]="18" />
              Try again
            </sd-button>
          </sd-empty-state>
        }
        @case ('empty') {
          <sd-empty-state
            icon="flask-conical"
            title="No lab requests yet"
            message="When a doctor requests tests or scans for you, they appear here."
          />
        }
        @case ('filtered-empty') {
          <sd-empty-state icon="filter" title="Nothing in this filter.">
            <sd-button variant="outline" (click)="setGroup('all')"
              >Show all lab tests</sd-button
            >
          </sd-empty-state>
        }
        @default {
          <ul class="flex flex-col gap-4" aria-label="Lab requests">
            @for (r of rows(); track r.id) {
              <li>
                <a
                  [routerLink]="['/dashboard/lab-requests', r.id]"
                  class="sd-card-hover flex items-start gap-4 rounded-card border border-haze bg-white p-5 shadow-card hover:border-cerulean/50"
                >
                  <span
                    class="hidden size-12 shrink-0 items-center justify-center rounded-full bg-teal/10 text-teal-ink sm:flex"
                    aria-hidden="true"
                  >
                    <sd-icon name="flask-conical" [size]="22" />
                  </span>
                  <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div
                      class="flex flex-wrap items-start justify-between gap-2"
                    >
                      <p
                        class="min-w-0 break-words font-sans text-body font-semibold text-ink"
                      >
                        Lab request from {{ doctor(r) }}
                      </p>
                      <span
                        class="inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-0.5 font-sans text-caption font-medium inset-ring inset-ring-current/20"
                        [class]="chip(r).cls"
                      >
                        <sd-icon [name]="chip(r).icon" [size]="14" />
                        {{ chip(r).label }}
                      </span>
                    </div>
                    <p
                      class="font-sans text-body-sm text-slate [overflow-wrap:anywhere]"
                    >
                      @for (p of numberParts(r.number); track $index) {
                        <span>{{ p }}</span><wbr />
                      }
                    </p>
                    <div
                      class="flex flex-wrap gap-x-4 gap-y-1 font-sans text-caption text-slate"
                    >
                      <span class="flex items-center gap-1.5">
                        <sd-icon name="flask-conical" [size]="14" />
                        {{ tests(r.items_count) }} · {{ priority(r) }}
                      </span>
                      <span class="flex items-center gap-1.5">
                        <sd-icon name="send" [size]="14" />
                        Sent {{ sent(r) }}
                      </span>
                    </div>
                    @if (helper(r); as h) {
                      <p class="font-sans text-body-sm text-ink">{{ h }}</p>
                    }
                  </div>
                  <sd-icon
                    name="chevron-right"
                    [size]="20"
                    class="mt-1 shrink-0 text-cerulean"
                    aria-hidden="true"
                  />
                </a>
              </li>
            }
          </ul>
          @if (hasMore()) {
            <button
              type="button"
              class="mx-auto rounded-field border border-haze bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:opacity-60 disabled:shadow-none"
              [disabled]="loadingMore()"
              (click)="loadMore()"
            >
              {{ loadingMore() ? 'Loading…' : 'Load more' }}
            </button>
          }
          @if (moreError()) {
            <p
              class="text-center font-sans text-caption text-alert-ink"
              role="alert"
            >
              {{ moreError() }}
            </p>
          }
        }
      }
    </div>
  `,
})
export class LabRequests {
  private readonly api = inject(LabRequestsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = viewerTimeZone();
  protected readonly numberParts = numberParts;

  protected readonly filters: readonly { key: LabListGroup; label: string }[] =
    [
      { key: 'all', label: 'All' },
      { key: 'awaiting_patient', label: 'Action needed' },
      { key: 'in_progress', label: 'In progress' },
      { key: 'result_ready', label: 'Results' },
    ];

  protected readonly group = signal<LabListGroup>('all');
  protected readonly rows = signal<PatientLabRequestSummaryDto[]>([]);
  protected readonly counts =
    signal<Record<LabListGroup, number>>(EMPTY_COUNTS);
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  /** The API's reason the list failed to load ('' when it hasn't). */
  protected readonly loadError = signal('');
  protected readonly moreError = signal('');
  private readonly page = signal(1);
  private readonly totalPages = signal(1);
  private sub: Subscription | null = null;

  protected readonly hasMore = computed(() => this.page() < this.totalPages());

  protected readonly viewState = computed<
    'loading' | 'error' | 'empty' | 'filtered-empty' | 'list'
  >(() => {
    if (this.loadError()) return 'error';
    if (this.loading()) return 'loading';
    if (this.counts().all === 0 && this.rows().length === 0) return 'empty';
    return this.rows().length === 0 ? 'filtered-empty' : 'list';
  });

  constructor() {
    this.load();
  }

  protected setGroup(group: LabListGroup): void {
    if (group === this.group() && !this.loadError()) return;
    this.group.set(group);
    this.load();
  }

  protected reload(): void {
    this.load();
  }

  protected loadMore(): void {
    if (this.loadingMore() || !this.hasMore()) return;
    this.fetch(this.page() + 1);
  }

  protected chip(r: PatientLabRequestSummaryDto) {
    return labChip(r);
  }

  protected helper(r: PatientLabRequestSummaryDto): string {
    return labHelper(r, r.doctor?.name);
  }

  protected doctor(r: PatientLabRequestSummaryDto): string {
    return labDoctor(r);
  }

  protected tests(n: number): string {
    return testsLabel(n);
  }

  protected priority(r: PatientLabRequestSummaryDto): string {
    return priorityLabel(r.priority);
  }

  protected sent(r: PatientLabRequestSummaryDto): string {
    return labDay(r.sent_at, this.zone) || '—';
  }

  private load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.rows.set([]);
    this.fetch(1);
  }

  private fetch(page: number): void {
    this.sub?.unsubscribe();
    this.moreError.set('');
    if (page > 1) this.loadingMore.set(true);
    this.sub = this.api
      .mine({ group: this.group(), page, per_page: PER_PAGE })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const data = res.data ?? [];
          this.rows.update((rows) => (page > 1 ? [...rows, ...data] : data));
          this.counts.set({ ...EMPTY_COUNTS, ...(res.meta?.counts ?? {}) });
          this.page.set(res.meta?.page ?? page);
          this.totalPages.set(res.meta?.total_pages ?? 1);
          this.loading.set(false);
          this.loadingMore.set(false);
        },
        error: (err: unknown) => {
          if (page > 1) {
            this.loadingMore.set(false);
            this.moreError.set(
              apiErrorMessage(
                err,
                "Couldn't load more lab tests. Please try again.",
              ),
            );
            return;
          }
          this.loadError.set(
            apiErrorMessage(
              err,
              "We couldn't load your lab tests. Check your connection and try again.",
            ),
          );
          this.loading.set(false);
        },
      });
  }
}
