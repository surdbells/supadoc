import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { ReviewDto, ReviewSummaryDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

/** Doctor reviews (route `/reviews`) — summary, list, and responses. */
@Component({
  selector: 'doc-reviews',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Reviews</h1>
        <p class="font-sans text-body text-slate">What your patients say.</p>
      </header>

      @if (summary(); as s) {
        <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6 sm:flex-row sm:items-center sm:gap-8">
          <div class="flex flex-col items-center gap-1">
            <span class="font-heading text-h1 text-ink">{{ s.average }}</span>
            <span class="flex gap-0.5">
              @for (i of [1,2,3,4,5]; track i) {
                <sd-icon name="star" [size]="16" [class]="i <= round(s.average) ? 'text-warning' : 'text-cloud'" />
              }
            </span>
            <span class="font-sans text-caption text-slate">{{ s.count }} review{{ s.count === 1 ? '' : 's' }}</span>
          </div>
          <div class="flex flex-1 flex-col gap-1.5">
            @for (star of [5,4,3,2,1]; track star) {
              <div class="flex items-center gap-2">
                <span class="w-8 font-sans text-caption text-slate">{{ star }}★</span>
                <span class="h-2 flex-1 overflow-hidden rounded-pill bg-glacier">
                  <span class="block h-full rounded-pill bg-warning" [style.width.%]="pct(s, star)"></span>
                </span>
                <span class="w-8 text-right font-sans text-caption text-slate">{{ s.distribution[star] || 0 }}</span>
              </div>
            }
          </div>
        </section>
      }

      <section class="flex flex-col gap-3">
        <ul class="flex flex-col gap-3">
          @for (r of reviews(); track r.id) {
            <li class="flex flex-col gap-2 rounded-card border border-cloud bg-white p-5">
              <div class="flex items-center justify-between gap-3">
                <span class="font-sans text-body-sm font-semibold text-ink">{{ r.patient_name }}</span>
                <span class="flex gap-0.5">
                  @for (i of [1,2,3,4,5]; track i) {
                    <sd-icon name="star" [size]="14" [class]="i <= r.rating ? 'text-warning' : 'text-cloud'" />
                  }
                </span>
              </div>
              @if (r.comment) { <p class="font-sans text-body-sm text-ink">{{ r.comment }}</p> }
              <span class="font-sans text-caption text-slate">{{ date(r.created_at) }}</span>

              @if (r.response) {
                <div class="mt-1 rounded-field bg-glacier px-4 py-3">
                  <p class="font-sans text-caption font-semibold text-cerulean">Your response</p>
                  <p class="font-sans text-body-sm text-ink">{{ r.response }}</p>
                </div>
              } @else if (replyingId() === r.id) {
                <div class="mt-1 flex flex-col gap-2">
                  <textarea rows="2" class="w-full rounded-field border border-cloud bg-white px-4 py-2.5 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" [value]="replyText()" (input)="replyText.set($any($event.target).value)" placeholder="Write a public response…"></textarea>
                  @if (replyError()) { <p class="font-sans text-caption text-alert">{{ replyError() }}</p> }
                  <div class="flex items-center gap-2">
                    <button type="button" class="rounded-field bg-cerulean px-4 py-2 font-sans text-caption font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="replyBusy()" (click)="submitReply(r)">{{ replyBusy() ? 'Posting…' : 'Post response' }}</button>
                    <button type="button" class="font-sans text-caption font-semibold text-slate hover:text-ink" (click)="replyingId.set(null)">Cancel</button>
                  </div>
                </div>
              } @else {
                <button type="button" class="w-fit font-sans text-caption font-semibold text-cerulean hover:underline" (click)="openReply(r)">Respond</button>
              }
            </li>
          } @empty {
            <li class="rounded-card border border-cloud bg-white px-5 py-16 text-center font-sans text-body-sm text-slate">{{ loading() ? 'Loading…' : 'No reviews yet.' }}</li>
          }
        </ul>
        @if (hasMore()) {
          <button type="button" class="mx-auto rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="loading()" (click)="loadMore()">{{ loading() ? 'Loading…' : 'Load more' }}</button>
        }
      </section>
    </div>
  `,
})
export class DoctorReviews implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly summary = signal<ReviewSummaryDto | null>(null);
  protected readonly reviews = signal<ReviewDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);
  private page = 1;

  protected readonly replyingId = signal<string | null>(null);
  protected readonly replyText = signal('');
  protected readonly replyBusy = signal(false);
  protected readonly replyError = signal('');

  ngOnInit(): void {
    this.api.reviewsSummary().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.summary.set(r.data), error: () => undefined });
    this.fetch();
  }

  protected loadMore(): void {
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    this.api
      .reviews({ page: this.page, per_page: 20 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.reviews.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  protected openReply(r: ReviewDto): void {
    this.replyingId.set(r.id);
    this.replyText.set('');
    this.replyError.set('');
  }

  protected submitReply(r: ReviewDto): void {
    if (this.replyText().trim() === '') {
      this.replyError.set('Write a response.');
      return;
    }
    this.replyBusy.set(true);
    this.replyError.set('');
    this.api
      .respondReview(r.id, this.replyText().trim())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.reviews.update((list) => list.map((x) => (x.id === r.id ? res.data : x)));
          this.replyingId.set(null);
          this.replyBusy.set(false);
        },
        error: (err) => {
          this.replyError.set(apiErrorMessage(err, 'Could not post the response.'));
          this.replyBusy.set(false);
        },
      });
  }

  protected round(avg: string): number {
    return Math.round(Number(avg) || 0);
  }
  protected pct(s: ReviewSummaryDto, star: number): number {
    if (!s.count) return 0;
    return Math.round(((s.distribution[star] || 0) / s.count) * 100);
  }
  protected date(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }
}
