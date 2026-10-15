import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type { ReviewDto, ReviewSummaryDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { BTN_SECONDARY, CARD, dateOnly, plural } from '../specialist-ui';

const PER_PAGE = 20;

/**
 * The doctor page's Reviews tab: the rating summary (a plain SVG bar per
 * star, built from numbers only) and patients' reviews, newest first.
 */
@Component({
  selector: 'bo-specialist-reviews',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="flex flex-col gap-5">
      @if (summary(); as s) {
        <section class="flex flex-col gap-4 ${CARD} p-4 sm:flex-row sm:items-center sm:gap-8 sm:p-6" aria-labelledby="bo-rev-sum-title">
          <div class="flex flex-col gap-1">
            <h2 id="bo-rev-sum-title" class="font-sans text-caption font-semibold text-slate">Average rating</h2>
            <span class="flex items-center gap-2 font-heading text-h3 text-ink"><sd-icon name="star" [size]="26" class="text-warning" />{{ s.average }}<span class="sr-only"> out of 5</span></span>
            <span class="font-sans text-caption text-slate">{{ plural(s.count, 'review') }}</span>
          </div>
          <svg class="w-full max-w-md" [attr.viewBox]="'0 0 300 ' + bars().length * 22" role="img" [attr.aria-label]="barsLabel()">
            @for (b of bars(); track b.stars; let i = $index) {
              <text x="0" [attr.y]="i * 22 + 15" class="fill-slate font-sans text-[12px]">{{ b.stars }}★</text>
              <rect x="28" [attr.y]="i * 22 + 5" width="230" height="12" rx="6" class="fill-glacier" />
              <rect x="28" [attr.y]="i * 22 + 5" [attr.width]="b.width" height="12" rx="6" class="fill-warning" />
              <text x="266" [attr.y]="i * 22 + 15" class="fill-ink font-sans text-[12px]">{{ b.count }}</text>
            }
          </svg>
        </section>
      }

      <p class="font-sans text-body-sm text-slate" aria-live="polite">
        @if (loading() && items().length === 0) { Loading reviews… }
      </p>

      @if (error() && items().length === 0) {
        <div class="flex flex-col items-center gap-3 ${CARD} px-5 py-10 text-center">
          <sd-icon name="wifi-off" [size]="28" class="text-alert" />
          <p class="font-sans text-body-sm text-slate" role="alert">{{ error() }}</p>
          <button type="button" class="${BTN_SECONDARY}" (click)="reload()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
        </div>
      } @else if (!(loading() && items().length === 0)) {
        <ul class="flex flex-col gap-3">
          @for (r of items(); track r.id) {
            <li class="flex flex-col gap-2 ${CARD} p-4 sm:p-5">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="flex items-center gap-1 font-sans text-body-sm font-semibold text-ink">
                  <sd-icon name="star" [size]="16" class="text-warning" />{{ r.rating }}<span class="sr-only"> out of 5</span><span aria-hidden="true">/5</span>
                  <span class="font-normal text-slate">· {{ r.patient_name }}</span>
                </span>
                <span class="font-sans text-caption text-slate">{{ day(r.created_at) }}</span>
              </div>
              @if (r.comment) {
                <p class="whitespace-pre-line break-words font-sans text-body-sm text-ink">{{ r.comment }}</p>
              }
              @if (r.response) {
                <p class="rounded-field bg-glacier px-3 py-2 font-sans text-caption text-ink"><span class="font-semibold">Doctor replied:</span> {{ r.response }}</p>
              }
            </li>
          } @empty {
            <li class="${CARD} px-5 py-10 text-center font-sans text-body-sm text-slate">No reviews yet.</li>
          }
        </ul>
        @if (error()) {
          <p class="text-center font-sans text-caption text-alert" role="alert">{{ error() }}</p>
        }
        @if (hasMore()) {
          <button type="button" class="${BTN_SECONDARY} mx-auto" [disabled]="loading()" (click)="loadMore()">{{ loading() ? 'Loading…' : 'Load more' }}</button>
        }
      }
    </div>
  `,
})
export class SpecialistReviewsTab implements OnInit {
  private readonly api = inject(SpecialistsApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly specialistId = input.required<string>();

  /** The page's headline rating (from the doctor's stats). */
  readonly summary = input<ReviewSummaryDto | null>(null);
  protected readonly items = signal<ReviewDto[]>([]);
  protected readonly hasMore = signal(false);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  private page = 1;

  protected readonly bars = computed(() => {
    const dist = this.summary()?.distribution ?? {};
    const counts = [5, 4, 3, 2, 1].map((stars) => ({ stars, count: Math.max(0, Number(dist[String(stars)]) || 0) }));
    const max = Math.max(1, ...counts.map((c) => c.count));
    return counts.map((c) => ({ ...c, width: Math.round((c.count / max) * 230) }));
  });
  protected readonly barsLabel = computed(
    () => 'Ratings: ' + this.bars().map((b) => `${b.stars} stars ${b.count}`).join(', '),
  );

  ngOnInit(): void {
    this.reload();
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
    this.loading.set(true);
    this.error.set('');
    this.api
      .doctorReviews(this.specialistId(), { page: this.page, per_page: PER_PAGE })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set((res.meta?.page ?? 1) < (res.meta?.total_pages ?? 1));
          this.loading.set(false);
        },
        error: (err: unknown) => {
          if (this.page > 1) this.page -= 1;
          this.error.set(apiErrorMessage(err, "Could not load this doctor's reviews."));
          this.loading.set(false);
        },
      });
  }

  protected day(iso: string): string {
    return dateOnly(iso);
  }
  protected plural(n: number, word: string): string {
    return plural(n, word);
  }
}
