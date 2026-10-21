import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, DocumentSharingApi } from '@supadoc/data-access';
import type { DocumentAccessRequestDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { type ApproveOutcome, ApproveRequestDialog } from './approve-request-dialog';
import { isSharingUnavailable, requestMeta, requestTitle, SHARING_UNAVAILABLE } from './document-sharing';

/** Cards shown before "Show N more". */
const VISIBLE = 2;

/** The HTTP status of either error shape (`ApiError.statusCode` / `HttpErrorResponse.status`). */
function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  return typeof e.status === 'number' ? e.status : undefined;
}

/** Why the region can't show what it should. */
type BannerProblem =
  /** 503 `sharing_unavailable`: the fixed copy, no actions. */
  | { readonly kind: 'unavailable' }
  /** The pending list, or the `?request=` one, could not be read; `retry` says what Try again does. */
  | { readonly kind: 'error'; readonly text: string; readonly retry: 'list' | 'request' | null };

type BannerError = Extract<BannerProblem, { kind: 'error' }>;

/**
 * Doctors' pending requests to see the patient's documents, as cards above the
 * Medical Documents list and on Manage sharing (nothing renders when there are
 * none): who asks, when, for which consultation, until when it stays open,
 * their note, and **Review request** / **Decline**. Also opens a request by id
 * (`openRequestId`, from a notification's `?request=` link) — a request that
 * is no longer pending opens as a short info dialog. When the list or that
 * request can't be read, it says so (with Try again) instead of showing
 * nothing: a patient who tapped "Review request" in an email must see why.
 */
@Component({
  selector: 'pat-access-requests-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ApproveRequestDialog, IconComponent],
  host: { class: 'block' },
  template: `
    @if (unavailable()) {
      <p class="flex items-start gap-2 rounded-card border border-haze bg-white p-4 font-sans text-body-sm text-slate shadow-card" role="status">
        <sd-icon name="lock" [size]="18" class="mt-0.5 shrink-0" />{{ unavailableText }}
      </p>
    } @else if (errors().length > 0) {
      <div class="flex flex-col gap-3">
        @for (p of errors(); track $index) {
          <div class="flex flex-col gap-3 rounded-card border border-haze bg-white p-4 shadow-card sm:flex-row sm:items-center sm:justify-between">
            <p class="flex items-start gap-2 font-sans text-body-sm text-alert-ink" role="alert">
              <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ p.text }}
            </p>
            @if (p.retry) {
              <button type="button" class="inline-flex min-h-11 w-fit shrink-0 items-center rounded-field border border-haze bg-white px-5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean disabled:opacity-60" [disabled]="retrying()" (click)="tryAgain(p.retry)">
                Try again
              </button>
            }
          </div>
        }
      </div>
    }

    @if (requests().length > 0) {
      <section class="flex flex-col gap-3" [class.mt-3]="errors().length > 0" aria-labelledby="access-requests-title">
        <h2 id="access-requests-title" class="sr-only">Requests to see your documents</h2>
        <ul class="flex flex-col gap-3">
          @for (r of shown(); track r.id) {
            <li class="flex flex-col gap-3 rounded-card border border-haze bg-white p-4 shadow-card sm:flex-row sm:items-center sm:gap-4">
              <div class="flex min-w-0 flex-1 items-start gap-3">
                <span class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning-ink" aria-hidden="true">
                  <sd-icon name="key-round" [size]="20" />
                </span>
                <span class="flex min-w-0 flex-col gap-1">
                  <span class="font-sans text-body-sm font-semibold text-ink">{{ title(r) }}</span>
                  <span class="font-sans text-caption text-slate">{{ meta(r) }}</span>
                  @if (r.message) {
                    <span class="wrap-anywhere font-sans text-caption text-ink">Their note: “{{ r.message }}”</span>
                  }
                </span>
              </div>
              <div class="flex flex-wrap gap-2 pl-14 sm:pl-0">
                <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field bg-cerulean px-4 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="review(r)">
                  Review request
                </button>
                <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field border border-haze bg-white px-4 font-sans text-body-sm font-semibold text-slate shadow-control transition hover:border-cerulean" (click)="review(r, true)">
                  Decline
                </button>
              </div>
            </li>
          }
        </ul>
        @if (hiddenCount() > 0) {
          <button type="button" class="min-h-11 w-fit font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean" (click)="expanded.set(true)">
            Show {{ hiddenCount() }} more
          </button>
        }
      </section>
    }

    @if (active(); as a) {
      <pat-approve-request-dialog
        [request]="a.request"
        [startWithDecline]="a.decline"
        (done)="answered($event)"
        (closed)="active.set(null)"
      />
    }
  `,
})
export class AccessRequestsBanner {
  private readonly sharing = inject(DocumentSharingApi);
  private readonly destroyRef = inject(DestroyRef);

  /** Open this request (a notification's `?request=` link). */
  readonly openRequestId = input<string | null>(null);
  /** A request was approved or declined (or turned out to be closed already). */
  readonly handled = output<ApproveOutcome>();
  /** `openRequestId` was taken up: the host may drop the query parameter. */
  readonly opened = output<void>();

  protected readonly unavailableText = SHARING_UNAVAILABLE;
  protected readonly requests = signal<DocumentAccessRequestDto[]>([]);
  protected readonly expanded = signal(false);
  protected readonly active = signal<{ request: DocumentAccessRequestDto; decline: boolean } | null>(null);
  protected readonly shown = computed(() => (this.expanded() ? this.requests() : this.requests().slice(0, VISIBLE)));
  protected readonly hiddenCount = computed(() => this.requests().length - this.shown().length);
  /** The pending list could not be read. */
  private readonly listProblem = signal<BannerProblem | null>(null);
  /** The `?request=` request could not be read. */
  private readonly requestProblem = signal<BannerProblem | null>(null);
  /** Sharing is off: only the fixed copy shows. */
  protected readonly unavailable = computed(
    () => this.listProblem()?.kind === 'unavailable' || this.requestProblem()?.kind === 'unavailable',
  );
  protected readonly errors = computed(() =>
    [this.requestProblem(), this.listProblem()].filter((p): p is BannerError => p?.kind === 'error'),
  );
  protected readonly retrying = signal(false);
  private readonly loaded = signal(false);
  private handledId = '';
  /** The `?request=` id that could not be read (for Try again). */
  private failedRequestId = '';

  constructor() {
    this.reload();
    // `?request=`: open it once the list is known (fetching it when it isn't pending).
    effect(() => {
      const id = this.openRequestId();
      if (!id || id === this.handledId || !this.loaded()) return;
      untracked(() => this.openById(id));
    });
  }

  /** Re-read the pending requests (after a share elsewhere on the page, too). */
  reload(): void {
    this.sharing
      .requests({ status: 'pending' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.requests.set((res.data ?? []).filter((r) => r.status === 'pending'));
          this.retrying.set(false);
          this.listProblem.set(null);
          // Sharing answered, so it isn't off.
          if (this.requestProblem()?.kind === 'unavailable') this.requestProblem.set(null);
          this.loaded.set(true);
        },
        error: (err: unknown) => {
          this.retrying.set(false);
          this.requests.set([]);
          this.listProblem.set(
            isSharingUnavailable(err)
              ? { kind: 'unavailable' }
              : {
                  kind: 'error',
                  text: apiErrorMessage(err, 'Could not load requests to see your documents.'),
                  retry: 'list',
                },
          );
          // Still look up a `?request=` link: its own answer says more.
          this.loaded.set(true);
        },
      });
  }

  private openById(id: string): void {
    this.handledId = id;
    this.opened.emit();
    const known = this.requests().find((r) => r.id === id);
    if (known) {
      this.active.set({ request: known, decline: false });
      return;
    }
    this.sharing
      .request(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.retrying.set(false);
          this.failedRequestId = '';
          this.requestProblem.set(null);
          this.active.set({ request: res.data, decline: false });
        },
        error: (err: unknown) => {
          this.retrying.set(false);
          if (isSharingUnavailable(err)) {
            this.requestProblem.set({ kind: 'unavailable' });
            return;
          }
          // 404 / 403: not this patient's request (or gone) — trying again won't help.
          const status = httpStatus(err);
          const gone = status === 404 || status === 403;
          this.failedRequestId = gone ? '' : id;
          this.requestProblem.set({
            kind: 'error',
            text: gone
              ? 'This request could not be found. It may have been for another account.'
              : apiErrorMessage(err, 'Could not open this request.'),
            retry: gone ? null : 'request',
          });
        },
      });
  }

  protected tryAgain(what: 'list' | 'request'): void {
    if (this.retrying()) return;
    this.retrying.set(true);
    if (what === 'request' && this.failedRequestId) {
      this.openById(this.failedRequestId);
      return;
    }
    this.reload();
  }

  protected review(r: DocumentAccessRequestDto, decline = false): void {
    this.active.set({ request: r, decline });
  }

  protected answered(outcome: ApproveOutcome): void {
    this.handled.emit(outcome);
    this.reload();
  }

  protected title(r: DocumentAccessRequestDto): string {
    return requestTitle(r);
  }
  protected meta(r: DocumentAccessRequestDto): string {
    return requestMeta(r);
  }
}
