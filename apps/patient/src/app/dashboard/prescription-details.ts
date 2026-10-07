import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  catchError,
  distinctUntilChanged,
  from,
  map,
  of,
  Subscription,
  switchMap,
} from 'rxjs';
import {
  apiErrorMessage,
  openPendingTab,
  PrescriptionsApi,
} from '@supadoc/data-access';
import type { FollowUpMode, PrescriptionDto, PrescriptionItem } from '@supadoc/models';
import {
  AlertComponent,
  ButtonComponent,
  EmptyStateComponent,
  IconComponent,
} from '@supadoc/ui';
import { rxDate, rxStatus, type RxStatusMeta } from './prescriptions';

type FileAction = 'view' | 'download' | 'print';

const FOLLOW_UP: Record<FollowUpMode, { label: string; icon: string }> = {
  video: { label: 'Video', icon: 'video' },
  in_person: { label: 'In person', icon: 'user' },
};

/** HTTP status from either error shape (normalised `ApiError.statusCode` or raw `status`). */
function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
}

/**
 * One prescription (GVM-RX-02) — wired to GET /api/portal/prescriptions/{id}.
 * Shows the status (icon + text), prescriber, dates, the medicines, advice,
 * follow-up and tests, and offers the PDF three ways: full screen (the
 * browser's PDF viewer — pinch-zoom on phones), download and print. Expired and
 * cancelled files come stamped by the server, and the page says so.
 */
@Component({
  selector: 'pat-prescription-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AlertComponent, ButtonComponent, EmptyStateComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex min-w-0 flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Prescription details</h1>
          <p class="font-sans text-body text-slate">
            View, download or print your prescription.
          </p>
        </div>
        <a
          routerLink="/dashboard/prescriptions"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      @switch (viewState()) {
        @case ('loading') {
          <div class="flex flex-col gap-6" aria-busy="true" aria-label="Loading prescription">
            <div class="h-44 animate-pulse rounded-card bg-cloud"></div>
            <div class="h-28 animate-pulse rounded-card bg-cloud"></div>
            <div class="h-56 animate-pulse rounded-card bg-cloud"></div>
          </div>
        }
        @case ('not-found') {
          <sd-empty-state
            tone="error"
            icon="file-text"
            title="Prescription not found"
            [message]="loadError()"
          >
            <a
              routerLink="/dashboard/prescriptions"
              class="rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-cerulean-dark"
              >Back to prescriptions</a
            >
          </sd-empty-state>
        }
        @case ('error') {
          <sd-empty-state
            tone="error"
            icon="wifi-off"
            title="Couldn't load this prescription"
            [message]="loadError()"
          >
            <div class="flex flex-wrap items-center justify-center gap-3">
              <sd-button variant="outline" (click)="reload()">
                <sd-icon name="refresh-cw" [size]="18" />
                Try again
              </sd-button>
              <a
                routerLink="/dashboard/prescriptions"
                class="font-sans text-body-sm font-semibold text-cerulean hover:underline"
                >Back to prescriptions</a
              >
            </div>
          </sd-empty-state>
        }
        @default {
          @if (rx(); as p) {
            <!-- Summary -->
            <section
              class="flex flex-col gap-5 rounded-card border border-cloud bg-white p-5 sm:p-6"
              aria-labelledby="rx-number"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="flex min-w-0 items-center gap-3">
                  <span
                    class="flex size-12 shrink-0 items-center justify-center rounded-full bg-teal/10 text-teal"
                    aria-hidden="true"
                  >
                    <sd-icon name="pill" [size]="22" />
                  </span>
                  <div class="flex min-w-0 flex-col">
                    <span class="font-sans text-caption text-slate">Prescription number</span>
                    <p id="rx-number" class="break-words font-heading text-h5 text-ink">
                      {{ p.number }}
                    </p>
                  </div>
                </div>
                <span
                  class="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1 font-sans text-body-sm font-medium"
                  [class]="status().class"
                >
                  <sd-icon [name]="status().icon" [size]="16" />
                  {{ status().label }}
                </span>
              </div>

              <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div class="flex flex-col gap-1">
                  <dt class="flex items-center gap-1.5 font-sans text-caption text-slate">
                    <sd-icon name="stethoscope" [size]="14" />Doctor
                  </dt>
                  <dd class="font-sans text-body font-semibold text-ink">
                    {{ doctorName() }}
                  </dd>
                  @if (p.prescriber_details.specialty) {
                    <dd class="font-sans text-caption text-slate">
                      {{ p.prescriber_details.specialty }}
                    </dd>
                  }
                </div>
                <div class="flex flex-col gap-1">
                  <dt class="flex items-center gap-1.5 font-sans text-caption text-slate">
                    <sd-icon name="send" [size]="14" />Date sent
                  </dt>
                  <dd class="font-sans text-body font-semibold text-ink">{{ date(p.sent_at) }}</dd>
                </div>
                <div class="flex flex-col gap-1">
                  <dt class="flex items-center gap-1.5 font-sans text-caption text-slate">
                    <sd-icon name="calendar-days" [size]="14" />Valid until
                  </dt>
                  <dd class="font-sans text-body font-semibold text-ink">
                    {{ date(p.valid_until) }}
                  </dd>
                </div>
                <div class="flex flex-col gap-1">
                  <dt class="flex items-center gap-1.5 font-sans text-caption text-slate">
                    <sd-icon name="refresh-cw" [size]="14" />Repeats allowed
                  </dt>
                  <dd class="font-sans text-body font-semibold text-ink">
                    {{ p.allows_repeats ? 'Yes' : 'No' }}
                  </dd>
                </div>
              </dl>

              @switch (p.status) {
                @case ('active') {
                  <sd-alert tone="info">
                    Show this prescription at any pharmacy. GVM does not track when
                    your medicines are given out.
                  </sd-alert>
                }
                @case ('expired') {
                  <sd-alert tone="warning">
                    <span class="text-ink">
                      @if (p.valid_until) {
                        This prescription was valid until {{ date(p.valid_until) }} and
                        has expired.
                      } @else {
                        This prescription has expired.
                      }
                      A pharmacy can no longer accept it. Book a consultation if you
                      need more.
                    </span>
                    <a
                      [routerLink]="bookLink()"
                      class="mt-2 flex w-fit items-center gap-1 font-semibold text-cerulean hover:underline"
                    >
                      <sd-icon name="calendar-plus" [size]="16" />
                      Book a consultation
                    </a>
                  </sd-alert>
                }
                @case ('cancelled') {
                  <sd-alert tone="error">
                    <span class="font-semibold">
                      Your doctor cancelled this prescription. Do not use it.
                    </span>
                    @if (p.cancel_reason) {
                      <span class="mt-1 block text-ink">
                        Reason: {{ p.cancel_reason }}
                      </span>
                    }
                  </sd-alert>
                }
              }
            </section>

            <!-- The PDF -->
            <section
              class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-5 sm:p-6"
              aria-labelledby="rx-file-heading"
            >
              <h2
                id="rx-file-heading"
                class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
              >
                <sd-icon name="file-text" [size]="20" />Prescription file
              </h2>
              <div class="grid grid-cols-1 gap-3 md:grid-cols-3 lg:max-w-2xl">
                <sd-button [full]="true" [disabled]="busy() !== null" (click)="view()">
                  <sd-icon
                    [name]="busy() === 'view' ? 'loader-circle' : 'maximize-2'"
                    [size]="18"
                    class="inline-flex"
                    [class.animate-spin]="busy() === 'view'"
                  />
                  View full screen
                </sd-button>
                <sd-button
                  variant="outline"
                  [full]="true"
                  [disabled]="busy() !== null"
                  (click)="download()"
                >
                  <sd-icon
                    [name]="busy() === 'download' ? 'loader-circle' : 'download'"
                    [size]="18"
                    class="inline-flex"
                    [class.animate-spin]="busy() === 'download'"
                  />
                  Download
                </sd-button>
                <sd-button
                  variant="outline"
                  [full]="true"
                  [disabled]="busy() !== null"
                  (click)="print()"
                >
                  <sd-icon
                    [name]="busy() === 'print' ? 'loader-circle' : 'printer'"
                    [size]="18"
                    class="inline-flex"
                    [class.animate-spin]="busy() === 'print'"
                  />
                  Print
                </sd-button>
              </div>
              @if (stamp(); as s) {
                <p class="flex items-center gap-2 font-sans text-body-sm text-ink">
                  <sd-icon name="info" [size]="16" class="shrink-0 text-slate" />
                  The file is marked {{ s }}.
                </p>
              }
              <div aria-live="polite" class="flex flex-col gap-3 empty:hidden">
                @if (actionError()) {
                  <sd-alert tone="error">{{ actionError() }}</sd-alert>
                }
                @if (actionNote()) {
                  <sd-alert tone="info">
                    {{ actionNote() }}
                    @if (fallbackUrl(); as url) {
                      <a
                        [href]="url"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="mt-1 flex w-fit items-center gap-1 font-semibold underline"
                      >
                        <sd-icon name="external-link" [size]="16" />
                        Open the prescription
                      </a>
                    }
                  </sd-alert>
                }
              </div>
            </section>

            <!-- Medicines -->
            <section
              class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-5 sm:p-6"
              aria-labelledby="rx-medicines-heading"
            >
              <h2
                id="rx-medicines-heading"
                class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
              >
                <sd-icon name="pill-bottle" [size]="20" />Medicines
                <span class="font-sans text-body-sm font-normal text-slate"
                  >({{ p.items.length }})</span
                >
              </h2>
              @if (p.items.length === 0) {
                <p class="font-sans text-body-sm text-slate">
                  No medicines are listed on this prescription.
                </p>
              } @else {
                <ol class="flex flex-col gap-4">
                  @for (item of p.items; track $index) {
                    <li class="flex flex-col gap-3 rounded-card border border-cloud p-4">
                      <div class="flex flex-wrap items-start justify-between gap-2">
                        <div class="flex min-w-0 flex-col gap-0.5">
                          <p class="break-words font-sans text-body font-semibold text-ink">
                            {{ $index + 1 }}. {{ item.name }}
                          </p>
                          @if (item.generic_name && item.generic_name !== item.name) {
                            <p class="break-words font-sans text-caption text-slate">
                              Generic name: {{ item.generic_name }}
                            </p>
                          }
                        </div>
                        @if (item.no_substitute) {
                          <span
                            class="inline-flex shrink-0 items-center gap-1 rounded-pill bg-warning/15 px-2.5 py-0.5 font-sans text-caption font-medium text-ink"
                          >
                            <sd-icon name="badge-alert" [size]="14" />
                            No substitute
                          </span>
                        }
                      </div>
                      <dl class="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                        <div class="flex min-w-0 flex-col gap-0.5">
                          <dt class="font-sans text-caption text-slate">Dose</dt>
                          <dd class="break-words font-sans text-body-sm text-ink">{{ item.dose || '—' }}</dd>
                        </div>
                        <div class="flex min-w-0 flex-col gap-0.5">
                          <dt class="font-sans text-caption text-slate">Route</dt>
                          <dd class="break-words font-sans text-body-sm text-ink">{{ item.route || '—' }}</dd>
                        </div>
                        <div class="flex min-w-0 flex-col gap-0.5">
                          <dt class="font-sans text-caption text-slate">How often</dt>
                          <dd class="break-words font-sans text-body-sm text-ink">
                            {{ item.frequency || '—' }}
                          </dd>
                        </div>
                        <div class="flex min-w-0 flex-col gap-0.5">
                          <dt class="font-sans text-caption text-slate">How long</dt>
                          <dd class="break-words font-sans text-body-sm text-ink">
                            {{ item.duration || '—' }}
                          </dd>
                        </div>
                        <div class="flex min-w-0 flex-col gap-0.5">
                          <dt class="font-sans text-caption text-slate">Quantity</dt>
                          <dd class="break-words font-sans text-body-sm text-ink">
                            {{ item.quantity || '—' }}
                          </dd>
                        </div>
                        <div class="flex min-w-0 flex-col gap-0.5">
                          <dt class="font-sans text-caption text-slate">Repeats</dt>
                          <dd class="font-sans text-body-sm text-ink">{{ repeats(item) }}</dd>
                        </div>
                      </dl>
                      @if (item.instructions) {
                        <p
                          class="whitespace-pre-line break-words rounded-field bg-glacier px-3 py-2 font-sans text-body-sm text-ink"
                        >
                          <span class="font-semibold">Instructions: </span>{{ item.instructions }}
                        </p>
                      }
                    </li>
                  }
                </ol>
                @if (hasNoSubstitute()) {
                  <p class="flex items-start gap-2 font-sans text-caption text-slate">
                    <sd-icon name="badge-alert" [size]="14" class="mt-0.5 shrink-0" />
                    "No substitute" means the pharmacy must give exactly this brand.
                  </p>
                }
              }
            </section>

            <!-- Advice, follow-up, tests and referrals -->
            @if (p.advice || hasFollowUp() || p.tests_referrals) {
              <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
                @if (p.advice) {
                  <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-5 sm:p-6">
                    <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean">
                      <sd-icon name="clipboard-list" [size]="20" />Advice
                    </h2>
                    <p class="whitespace-pre-line break-words font-sans text-body-sm text-ink">
                      {{ p.advice }}
                    </p>
                  </section>
                }
                @if (hasFollowUp()) {
                  <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-5 sm:p-6">
                    <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean">
                      <sd-icon name="calendar-days" [size]="20" />Follow-up
                    </h2>
                    <div class="flex flex-col gap-2 font-sans text-body-sm text-ink">
                      @if (p.follow_up_date) {
                        <span class="flex items-center gap-2">
                          <sd-icon name="calendar-days" [size]="16" class="text-slate" />
                          {{ date(p.follow_up_date) }}
                        </span>
                      }
                      @if (followUp(); as f) {
                        <span class="flex items-center gap-2">
                          <sd-icon [name]="f.icon" [size]="16" class="text-slate" />
                          {{ f.label }}
                        </span>
                      }
                    </div>
                    @if (canBookFollowUp()) {
                      <a
                        [routerLink]="['/dashboard/appointments/book', p.specialist_id]"
                        class="mt-1 inline-flex w-fit items-center gap-2 rounded-field bg-cerulean px-4 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-cerulean-dark"
                      >
                        <sd-icon name="video" [size]="16" />
                        Book video follow-up
                      </a>
                    }
                  </section>
                }
                @if (p.tests_referrals) {
                  <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-5 sm:p-6">
                    <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean">
                      <sd-icon name="search-check" [size]="20" />Tests and referrals
                    </h2>
                    <p class="whitespace-pre-line break-words font-sans text-body-sm text-ink">
                      {{ p.tests_referrals }}
                    </p>
                  </section>
                }
              </div>
            }
          }
        }
      }
    </div>
  `,
})
export class PrescriptionDetails {
  private readonly api = inject(PrescriptionsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly doc = inject(DOCUMENT);

  protected readonly rx = signal<PrescriptionDto | null>(null);
  private readonly loading = signal(true);
  private readonly notFound = signal(false);
  /** The API's reason the prescription failed to load ('' when it hasn't). */
  protected readonly loadError = signal('');

  protected readonly busy = signal<FileAction | null>(null);
  protected readonly actionError = signal('');
  protected readonly actionNote = signal('');
  /** A direct link offered when the browser blocked the print fallback tab. */
  protected readonly fallbackUrl = signal<string | null>(null);

  private id = '';
  private loadSub: Subscription | null = null;
  private printFrame: HTMLIFrameElement | null = null;
  private printObjectUrl: string | null = null;
  private printTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly viewState = computed<'loading' | 'not-found' | 'error' | 'ready'>(() => {
    if (this.loading()) return 'loading';
    if (this.loadError()) return this.notFound() ? 'not-found' : 'error';
    return 'ready';
  });

  protected readonly status = computed<RxStatusMeta>(() => rxStatus(this.rx()?.status));

  protected readonly doctorName = computed(() => {
    const p = this.rx();
    return p?.prescriber_details?.name || p?.prescriber || 'Your doctor';
  });

  /** Expired/cancelled PDFs come stamped by the server. */
  protected readonly stamp = computed(() => {
    const s = this.rx()?.status;
    return s === 'expired' ? 'EXPIRED' : s === 'cancelled' ? 'CANCELLED' : null;
  });

  protected readonly hasNoSubstitute = computed(
    () => this.rx()?.items.some((i) => i.no_substitute) ?? false,
  );

  protected readonly hasFollowUp = computed(() => {
    const p = this.rx();
    return !!(p?.follow_up_date || p?.follow_up_mode);
  });

  protected readonly followUp = computed(() => {
    const mode = this.rx()?.follow_up_mode;
    return mode ? (FOLLOW_UP[mode] ?? null) : null;
  });

  protected readonly canBookFollowUp = computed(() => {
    const p = this.rx();
    return !!p && p.status === 'active' && p.follow_up_mode === 'video' && !!p.specialist_id;
  });

  /** Book again with the same doctor when we know who; otherwise the directory. */
  protected readonly bookLink = computed<string[]>(() => {
    const sid = this.rx()?.specialist_id;
    return sid ? ['/dashboard/appointments/book', sid] : ['/dashboard/specialists'];
  });

  constructor() {
    this.route.paramMap
      .pipe(
        map((p) => p.get('id') ?? ''),
        distinctUntilChanged(),
        takeUntilDestroyed(),
      )
      .subscribe((id) => {
        this.id = id;
        this.load();
      });
    this.destroyRef.onDestroy(() => this.cleanupPrint());
  }

  protected date(value: string | null): string {
    return rxDate(value);
  }

  protected repeats(item: PrescriptionItem): string {
    const n = Number(item.repeats) || 0;
    if (n <= 0) return 'None';
    return n === 1 ? '1 repeat' : `${n} repeats`;
  }

  protected reload(): void {
    this.load();
  }

  // ----- file actions -----

  /** Full screen: the browser's own PDF viewer in a new tab (pinch-zoom on phones). */
  protected view(): void {
    const p = this.rx();
    if (!p || this.busy()) return;
    // Open the tab synchronously inside the click so popup blockers allow it.
    const pending = openPendingTab();
    this.startAction('view');
    this.api
      .link(p.id, false)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          pending.go(this.api.fileUrl(res.data));
          this.busy.set(null);
        },
        error: (err: unknown) => {
          pending.fail();
          this.busy.set(null);
          this.actionError.set(
            apiErrorMessage(err, "We couldn't open your prescription. Please try again."),
          );
        },
      });
  }

  /** Download: the server answers the signed link with `attachment; filename=<number>.pdf`. */
  protected download(): void {
    const p = this.rx();
    if (!p || this.busy()) return;
    this.startAction('download');
    this.api
      .link(p.id, true)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const filename = res.data.filename || `${p.number}.pdf`;
          const a = this.doc.createElement('a');
          a.href = this.api.fileUrl(res.data);
          a.download = filename;
          a.rel = 'noopener';
          a.style.display = 'none';
          this.doc.body.appendChild(a);
          a.click();
          a.remove();
          this.busy.set(null);
          this.actionNote.set(`Your download has started (${filename}).`);
        },
        error: (err: unknown) => {
          this.busy.set(null);
          this.actionError.set(
            apiErrorMessage(err, "We couldn't download your prescription. Please try again."),
          );
        },
      });
  }

  /**
   * Print: fetch the PDF as a blob and print it from a hidden same-origin frame.
   * Phones and tablets can't print a PDF from a frame, so there (and whenever
   * the frame route fails) the file opens in a new tab to print from the viewer.
   */
  protected print(): void {
    const p = this.rx();
    if (!p || this.busy()) return;

    if (this.isTouchDevice()) {
      const pending = openPendingTab();
      this.startAction('print');
      this.api
        .link(p.id, false)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (res) => {
            pending.go(this.api.fileUrl(res.data));
            this.busy.set(null);
            this.actionNote.set(
              'Your prescription opened in a new tab. Use your browser’s print or share option to print it.',
            );
          },
          error: (err: unknown) => {
            pending.fail();
            this.busy.set(null);
            this.actionError.set(
              apiErrorMessage(err, "We couldn't get your prescription ready to print. Please try again."),
            );
          },
        });
      return;
    }

    this.startAction('print');
    this.api
      .link(p.id, false)
      .pipe(
        switchMap((res) => {
          const url = this.api.fileUrl(res.data);
          return from(this.fetchPdf(url)).pipe(
            map((blob): { url: string; blob: Blob | null } => ({ url, blob })),
            catchError(() => of({ url, blob: null })),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: ({ url, blob }) => {
          this.busy.set(null);
          if (blob) this.printBlob(blob, url);
          else this.printFallback(url);
        },
        error: (err: unknown) => {
          this.busy.set(null);
          this.actionError.set(
            apiErrorMessage(err, "We couldn't get your prescription ready to print. Please try again."),
          );
        },
      });
  }

  private startAction(action: FileAction): void {
    this.busy.set(action);
    this.actionError.set('');
    this.actionNote.set('');
    this.fallbackUrl.set(null);
  }

  private isTouchDevice(): boolean {
    try {
      const win = this.doc.defaultView;
      return !!win?.matchMedia?.('(hover: none) and (pointer: coarse)').matches;
    } catch {
      return false;
    }
  }

  private async fetchPdf(url: string): Promise<Blob> {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
  }

  private printBlob(blob: Blob, url: string): void {
    this.cleanupPrint();
    const objectUrl = URL.createObjectURL(blob);
    const frame = this.doc.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.title = 'Prescription for printing';
    Object.assign(frame.style, {
      position: 'fixed',
      right: '0',
      bottom: '0',
      width: '1px',
      height: '1px',
      border: '0',
      opacity: '0',
      pointerEvents: 'none',
    });
    frame.onload = () => {
      try {
        const w = frame.contentWindow;
        if (!w) throw new Error('No frame window');
        w.focus();
        w.print();
      } catch {
        this.printFallback(url);
      }
    };
    frame.src = objectUrl;
    this.doc.body.appendChild(frame);
    this.printFrame = frame;
    this.printObjectUrl = objectUrl;
    // The print dialog can hold the document for a while — tidy up later.
    this.printTimer = setTimeout(() => this.cleanupPrint(), 120_000);
  }

  /** Open the inline PDF in a new tab to print from the viewer; offer a link if blocked. */
  private printFallback(url: string): void {
    let opened: Window | null = null;
    try {
      opened = this.doc.defaultView?.open(url, '_blank') ?? null;
      if (opened) opened.opener = null;
    } catch {
      opened = null;
    }
    if (opened) {
      this.actionNote.set(
        'Your prescription opened in a new tab. Use your browser’s print option there.',
      );
    } else {
      this.fallbackUrl.set(url);
      this.actionNote.set(
        "We couldn't start printing here. Open your prescription and print it from there.",
      );
    }
  }

  private cleanupPrint(): void {
    if (this.printTimer) {
      clearTimeout(this.printTimer);
      this.printTimer = null;
    }
    if (this.printFrame) {
      this.printFrame.onload = null;
      this.printFrame.remove();
      this.printFrame = null;
    }
    if (this.printObjectUrl) {
      URL.revokeObjectURL(this.printObjectUrl);
      this.printObjectUrl = null;
    }
  }

  private load(): void {
    this.loadSub?.unsubscribe();
    this.loading.set(true);
    this.loadError.set('');
    this.notFound.set(false);
    this.actionError.set('');
    this.actionNote.set('');
    this.fallbackUrl.set(null);
    if (!this.id) {
      this.rx.set(null);
      this.notFound.set(true);
      this.loadError.set("We couldn't find this prescription.");
      this.loading.set(false);
      return;
    }
    this.loadSub = this.api
      .get(this.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.rx.set(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          const code = httpStatus(err);
          const missing = code === 404 || code === 403;
          this.rx.set(null);
          this.notFound.set(missing);
          this.loadError.set(
            apiErrorMessage(
              err,
              missing
                ? "We couldn't find this prescription. It may belong to another account, or the link may be wrong."
                : "We couldn't load this prescription. Check your connection and try again.",
            ),
          );
          this.loading.set(false);
        },
      });
  }
}
