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
import { apiErrorMessage, PrescriptionsApi } from '@supadoc/data-access';
import type { PrescriptionStatus, PrescriptionSummaryDto } from '@supadoc/models';
import { ButtonComponent, EmptyStateComponent, IconComponent } from '@supadoc/ui';

/** How a prescription status reads: never colour alone — always an icon AND text. */
export interface RxStatusMeta {
  readonly label: string;
  readonly icon: string;
  readonly class: string;
}

export const RX_STATUS: Record<PrescriptionStatus, RxStatusMeta> = {
  active: { label: 'Active', icon: 'circle-check', class: 'bg-success/10 text-success' },
  expired: { label: 'Expired', icon: 'hourglass', class: 'bg-cloud text-slate' },
  cancelled: { label: 'Cancelled', icon: 'circle-x', class: 'bg-alert/10 text-alert' },
  draft: { label: 'Draft', icon: 'pen-line', class: 'bg-frost/60 text-cerulean' },
};

export function rxStatus(status: PrescriptionStatus | null | undefined): RxStatusMeta {
  return (status && RX_STATUS[status]) || RX_STATUS.active;
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Parse `YYYY-MM-DD` as a LOCAL calendar date (no UTC shift); anything else as ISO. */
export function rxParseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** "4 Oct 2026", or an em dash when there is no date. */
export function rxDate(value: string | Date | null | undefined): string {
  const d = value instanceof Date ? value : rxParseDate(value);
  return d ? DATE_FMT.format(d) : '—';
}

type Tab = 'all' | 'active' | 'expired' | 'cancelled';

/**
 * My prescriptions (GVM-RX-02, Consultation History › Prescriptions) — every
 * prescription a doctor has sent the patient, newest first. A row never names
 * the medicines or the reason; tapping one opens the full prescription.
 */
@Component({
  selector: 'pat-prescriptions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ButtonComponent, EmptyStateComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Prescriptions</h1>
        <p class="font-sans text-body text-slate">
          Every prescription your doctors have sent you. Open one to view,
          download or print it.
        </p>
      </div>

      <!-- Consultation History › Prescriptions -->
      <nav
        aria-label="Consultation history sections"
        class="flex w-full items-center gap-1 rounded-pill border border-cloud bg-white p-1 sm:w-fit"
      >
        <a
          routerLink="/dashboard/history"
          class="flex flex-1 items-center justify-center gap-2 rounded-pill px-4 py-2 font-sans text-body-sm text-slate transition-colors hover:text-ink sm:flex-none"
        >
          <sd-icon name="history" [size]="16" />
          Consultations
        </a>
        <a
          routerLink="/dashboard/prescriptions"
          aria-current="page"
          class="flex flex-1 items-center justify-center gap-2 rounded-pill bg-cerulean px-4 py-2 font-sans text-body-sm font-medium text-white sm:flex-none"
        >
          <sd-icon name="pill" [size]="16" />
          Prescriptions
        </a>
      </nav>

      @if (!loading() && !loadError() && all().length > 0) {
        <!-- Status filter -->
        <div
          class="flex items-center gap-1 overflow-x-auto rounded-pill border border-cloud bg-white p-2"
          role="group"
          aria-label="Filter by status"
        >
          @for (t of tabs; track t.key) {
            <button
              type="button"
              class="flex shrink-0 items-center gap-1.5 rounded-pill px-4 py-1.5 font-sans text-body-sm transition-colors"
              [class]="
                activeTab() === t.key
                  ? 'bg-frost font-medium text-cerulean'
                  : 'text-slate hover:text-ink'
              "
              [attr.aria-pressed]="activeTab() === t.key"
              (click)="activeTab.set(t.key)"
            >
              {{ t.label }}
              <span class="font-sans text-caption">({{ count(t.key) }})</span>
            </button>
          }
        </div>
      }

      @switch (viewState()) {
        @case ('loading') {
          <div class="flex flex-col gap-4" aria-busy="true" aria-label="Loading prescriptions">
            @for (n of [1, 2, 3]; track n) {
              <div class="flex items-center gap-4 rounded-card border border-cloud bg-white p-4">
                <div class="hidden size-12 shrink-0 animate-pulse rounded-full bg-cloud sm:block"></div>
                <div class="flex flex-1 flex-col gap-2">
                  <div class="h-3 w-48 max-w-full animate-pulse rounded bg-cloud"></div>
                  <div class="h-3 w-32 animate-pulse rounded bg-cloud"></div>
                  <div class="h-3 w-56 max-w-full animate-pulse rounded bg-cloud"></div>
                </div>
              </div>
            }
          </div>
        }
        @case ('error') {
          <sd-empty-state
            tone="error"
            icon="wifi-off"
            title="Couldn't load your prescriptions"
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
            icon="pill"
            title="No prescriptions yet"
            message="When a doctor sends you one, it will appear here."
          />
        }
        @case ('filtered-empty') {
          <sd-empty-state
            icon="filter"
            [title]="'No ' + activeLabel().toLowerCase() + ' prescriptions'"
            message="None of your prescriptions have this status."
          >
            <sd-button variant="outline" (click)="activeTab.set('all')">
              Show all prescriptions
            </sd-button>
          </sd-empty-state>
        }
        @default {
          <ul class="flex flex-col gap-4">
            @for (rx of filtered(); track rx.id) {
              <li>
                <a
                  [routerLink]="['/dashboard/prescriptions', rx.id]"
                  class="sd-card-hover flex items-center gap-4 rounded-card border border-cloud bg-white p-4 hover:border-cerulean/50"
                >
                  <span
                    class="hidden size-12 shrink-0 items-center justify-center rounded-full bg-teal/10 text-teal sm:flex"
                    aria-hidden="true"
                  >
                    <sd-icon name="pill" [size]="22" />
                  </span>
                  <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <p class="min-w-0 break-words font-sans text-body font-semibold text-ink">
                        {{ rx.number }}
                      </p>
                      <span
                        class="inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-0.5 font-sans text-caption font-medium"
                        [class]="status(rx).class"
                      >
                        <sd-icon [name]="status(rx).icon" [size]="14" />
                        {{ status(rx).label }}
                      </span>
                    </div>
                    <p class="flex min-w-0 items-center gap-1.5 font-sans text-body-sm text-ink">
                      <sd-icon name="stethoscope" [size]="16" class="shrink-0 text-slate" />
                      <span class="truncate">{{ rx.prescriber || 'Your doctor' }}</span>
                    </p>
                    <div class="flex flex-wrap gap-x-4 gap-y-1 font-sans text-caption text-slate">
                      <span class="flex items-center gap-1.5">
                        <sd-icon name="send" [size]="14" />
                        Sent {{ date(rx.sent_at) }}
                      </span>
                      <span class="flex items-center gap-1.5">
                        <sd-icon name="calendar-days" [size]="14" />
                        Valid until {{ date(rx.valid_until) }}
                      </span>
                    </div>
                  </div>
                  <sd-icon
                    name="chevron-right"
                    [size]="20"
                    class="shrink-0 text-cerulean"
                    aria-hidden="true"
                  />
                </a>
              </li>
            }
          </ul>
        }
      }
    </div>
  `,
})
export class Prescriptions {
  private readonly api = inject(PrescriptionsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly activeTab = signal<Tab>('all');
  protected readonly tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'expired', label: 'Expired' },
    { key: 'cancelled', label: 'Cancelled' },
  ];

  protected readonly all = signal<PrescriptionSummaryDto[]>([]);
  protected readonly loading = signal(true);
  /** The API's reason the list failed to load ('' when it hasn't). */
  protected readonly loadError = signal('');

  protected readonly filtered = computed(() => {
    const tab = this.activeTab();
    const list = this.all();
    return tab === 'all' ? list : list.filter((rx) => rx.status === tab);
  });

  protected readonly activeLabel = computed(
    () => this.tabs.find((t) => t.key === this.activeTab())?.label ?? '',
  );

  protected readonly viewState = computed<
    'loading' | 'error' | 'empty' | 'filtered-empty' | 'list'
  >(() => {
    if (this.loadError()) return 'error';
    if (this.loading()) return 'loading';
    if (this.all().length === 0) return 'empty';
    return this.filtered().length === 0 ? 'filtered-empty' : 'list';
  });

  constructor() {
    this.load();
  }

  protected status(rx: PrescriptionSummaryDto): RxStatusMeta {
    return rxStatus(rx.status);
  }

  protected date(value: string | null): string {
    return rxDate(value);
  }

  protected count(tab: Tab): number {
    const list = this.all();
    return tab === 'all' ? list.length : list.filter((rx) => rx.status === tab).length;
  }

  protected reload(): void {
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.api
      .mine()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          // The API answers in sent order (newest first) — keep it, never re-sort
          // by created_at. Drafts never reach patients, but be safe.
          this.all.set((res.data ?? []).filter((rx) => rx.status !== 'draft'));
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loadError.set(
            apiErrorMessage(
              err,
              "We couldn't load your prescriptions. Check your connection and try again.",
            ),
          );
          this.loading.set(false);
        },
      });
  }
}
