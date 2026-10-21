import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, DocumentSharingApi } from '@supadoc/data-access';
import type { DocumentAccessEventDto, SharingDoctorDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { dateTimeLabel, drName, historyRows, isSharingUnavailable, SHARING_UNAVAILABLE } from './document-sharing';

const PAGE = 20;

/**
 * Manage sharing › Activity: the patient's sharing ledger, newest first —
 * every share, change and stop, every request and answer, and every time a
 * doctor opened a document (repeat opens within 10 minutes fold into one
 * row). Filter by doctor; "Load more" pages back.
 */
@Component({
  selector: 'pat-access-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-4" [attr.aria-busy]="loading() || null">
      @if (unavailable()) {
        <p class="flex items-start gap-2 rounded-card border border-haze bg-white p-5 font-sans text-body-sm text-slate shadow-card" role="status">
          <sd-icon name="lock" [size]="18" class="mt-0.5 shrink-0" />{{ unavailableText }}
        </p>
      } @else {
        @if (doctors().length > 0) {
          <label class="relative w-full sm:w-72">
            <span class="sr-only">Show activity for</span>
            <select
              class="min-h-11 w-full appearance-none rounded-field border border-haze bg-white py-2.5 pl-4 pr-10 font-sans text-body-sm text-ink shadow-control outline-none transition focus:border-cerulean"
              [value]="doctorId()"
              (change)="setDoctor($any($event.target).value)"
            >
              <option value="">All doctors</option>
              @for (d of doctors(); track d.specialist.id) {
                <option [value]="d.specialist.id">{{ dr(d.specialist.name) }}</option>
              }
            </select>
            <sd-icon name="chevron-down" [size]="16" class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate" />
          </label>
        }

        @if (loading() && events().length === 0) {
          @for (i of [1, 2, 3]; track i) { <div class="sd-shimmer h-14 rounded-card"></div> }
        } @else if (error() && events().length === 0) {
          <div class="flex flex-col items-start gap-3 rounded-card border border-haze bg-white p-5 shadow-card">
            <p class="flex items-start gap-2 font-sans text-body-sm text-alert-ink" role="alert">
              <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />Could not load activity.
            </p>
            <button type="button" class="min-h-11 rounded-field border border-haze bg-white px-5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean" (click)="reload()">Try again</button>
          </div>
        } @else if (rows().length === 0) {
          <p class="rounded-card border border-haze bg-white px-5 py-10 text-center font-sans text-body-sm text-slate shadow-card">
            No activity yet. When you share documents or a doctor opens one, it shows here.
          </p>
        } @else {
          <ul class="flex flex-col rounded-card border border-haze bg-white shadow-card" aria-label="Sharing activity">
            @for (r of rows(); track r.key) {
              <li class="flex items-start gap-3 border-t border-cloud px-4 py-3 first:border-t-0 sm:px-5">
                <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-glacier text-slate" aria-hidden="true">
                  <sd-icon [name]="r.icon" [size]="16" />
                </span>
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="wrap-anywhere font-sans text-body-sm text-ink">{{ r.text }}</span>
                  <span class="font-sans text-caption text-slate">{{ when(r.at) }}</span>
                </span>
              </li>
            }
          </ul>
          @if (error()) {
            <p class="font-sans text-caption text-alert-ink" role="alert">{{ error() }}</p>
          }
          @if (hasMore()) {
            <button type="button" class="mx-auto min-h-11 rounded-field border border-haze bg-white px-6 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean disabled:opacity-60" [disabled]="loading()" (click)="more()">
              {{ loading() ? 'Loading…' : 'Load more' }}
            </button>
          }
        }
      }
    </div>
  `,
})
export class AccessHistory {
  private readonly sharing = inject(DocumentSharingApi);
  private readonly destroyRef = inject(DestroyRef);

  /** Bump to reload from the first page. */
  readonly version = input(0);

  protected readonly unavailableText = SHARING_UNAVAILABLE;
  protected readonly events = signal<DocumentAccessEventDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly unavailable = signal(false);
  protected readonly hasMore = signal(false);
  protected readonly doctorId = signal('');
  /** The doctors the patient has booked, for the filter. */
  protected readonly doctors = signal<SharingDoctorDto[]>([]);
  protected readonly rows = computed(() => historyRows(this.events()));
  private page = 1;
  private seq = 0;

  constructor() {
    effect(() => {
      this.version();
      untracked(() => this.reload());
    });
    this.sharing
      .doctors()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (res) => this.doctors.set(res.data ?? []), error: () => undefined });
  }

  protected setDoctor(id: string): void {
    this.doctorId.set(id);
    this.reload();
  }

  protected reload(): void {
    this.page = 1;
    this.events.set([]);
    this.fetch();
  }

  protected more(): void {
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set('');
    this.sharing
      .history({ page: this.page, per_page: PAGE, specialist_id: this.doctorId() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (seq !== this.seq) return;
          this.events.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          if (seq !== this.seq) return;
          this.loading.set(false);
          if (this.page > 1) this.page -= 1;
          if (isSharingUnavailable(err)) this.unavailable.set(true);
          else this.error.set(apiErrorMessage(err, 'Could not load activity.'));
        },
      });
  }

  protected when(iso: string): string {
    return dateTimeLabel(iso);
  }
  protected dr(name: string): string {
    return drName(name);
  }
}
