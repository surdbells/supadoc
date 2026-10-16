import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  slotLabel,
  SpecialistsApi,
  todayLocal,
  viewerTimeZone,
  ymdInZone,
  type SpecialistSuggestionParams,
} from '@supadoc/data-access';
import type { SpecialistDto } from '@supadoc/models';
import { ButtonComponent, DialogComponent, DoctorProfileCardComponent, IconComponent, shortDayLabel } from '@supadoc/ui';
import { whenLabel } from './follow-up';
import { SimilarDoctors } from './similar-doctors';

let nextId = 0;

/** What the card's availability box says. */
interface WhenVm {
  readonly title: string;
  readonly detail: string;
  /** Up to three open times that day, each a link to booking it. */
  readonly times: readonly { iso: string; label: string; aria: string }[];
  /** Not free on the filtered day (or not soon at all): offer similar doctors. */
  readonly offerSimilar: boolean;
}

/**
 * One specialist in the directory (Figma 311:4126). When the doctor is free
 * comes with the listing (`availability`, no request per card): the badge reads
 * from the next opening, up to three open times link straight to booking them
 * (`?slot=`), and "See full calendar" opens the booking calendar. With a
 * filtered day (`date`) a doctor who isn't free then offers "See similar
 * doctors free that day".
 */
@Component({
  selector: 'pat-specialist-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogComponent, DoctorProfileCardComponent, IconComponent, RouterLink, SimilarDoctors],
  host: { class: 'block' },
  template: `
    <article
      class="flex h-full flex-col gap-4 rounded-card border border-haze bg-white p-6 shadow-card transition-colors duration-200 hover:border-cerulean/50 hover:bg-frost/20"
    >
      <!-- Header -->
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          @if (photoSrc(); as src) {
            <img
              [src]="src"
              [alt]="specialist().name"
              class="size-11 shrink-0 rounded-full object-cover"
            />
          } @else {
            <span
              class="flex size-11 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-body-sm font-semibold text-cerulean-dark"
            >
              {{ initials() }}
            </span>
          }
          <div class="flex min-w-0 flex-col">
            <p
              class="flex items-center gap-1.5 font-sans text-body font-semibold text-ink"
            >
              <span class="truncate">{{ specialist().name }}</span>
              @if (specialist().verified) {
                <sd-icon
                  name="circle-check"
                  [size]="16"
                  class="shrink-0 text-cerulean"
                />
              }
            </p>
            <p class="truncate font-sans text-caption text-slate">
              {{ specialist().specialty }}
            </p>
          </div>
        </div>
        <div class="flex shrink-0 flex-col items-end gap-1">
          @if (matchPercent() !== null) {
            <span class="font-sans text-body-sm font-bold text-cerulean"
              >{{ matchPercent() }}% Match</span
            >
          }
          <span
            class="rounded-pill px-3 py-1 font-sans text-[10px] font-medium inset-ring inset-ring-current/20"
            [class]="badge().class"
          >
            {{ badge().label }}
          </span>
        </div>
      </div>

      <!-- Meta -->
      <div class="flex flex-col gap-2 font-sans text-caption text-slate">
        <div class="flex items-center justify-between gap-2">
          <span class="flex min-w-0 items-center gap-1.5">
            <sd-icon name="map-pin" [size]="16" class="shrink-0" />
            <span class="truncate">{{ specialist().location ?? '—' }}</span>
          </span>
          @if (specialist().years_experience) {
            <span class="flex shrink-0 items-center gap-1.5">
              <sd-icon name="briefcase" [size]="16" />{{
                specialist().years_experience
              }}
              yrs experience
            </span>
          }
        </div>
        @if (specialist().languages) {
          <span class="flex items-center gap-1.5">
            <sd-icon name="languages" [size]="16" />{{ specialist().languages }}
          </span>
        }
      </div>

      <!-- When the doctor is free (from the listing — no request per card) -->
      @if (!specialist().available) {
        <div
          class="flex items-center gap-2 rounded-card border border-cloud bg-glacier/60 px-4 py-3 font-sans text-caption text-slate"
        >
          <sd-icon name="calendar-off" [size]="16" />
          Not accepting bookings right now.
        </div>
      } @else {
        <div
          class="flex flex-col gap-3 rounded-card border border-cloud bg-glacier/60 p-4"
        >
          <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span
              class="flex items-center gap-1.5 font-sans text-caption font-semibold text-cerulean"
            >
              <sd-icon [name]="when().offerSimilar ? 'calendar-off' : 'calendar-clock'" [size]="16" />{{ when().title }}
            </span>
            @if (when().detail) {
              <span class="font-sans text-caption font-medium text-ink">{{ when().detail }}</span>
            }
          </div>

          @if (when().times.length) {
            <div class="flex flex-wrap gap-2" role="group" [attr.aria-label]="'Open times with ' + specialist().name">
              @for (t of when().times; track t.iso) {
                <a
                  [routerLink]="bookPath()"
                  [queryParams]="{ slot: t.iso }"
                  class="inline-flex min-h-11 items-center rounded-field border border-cloud bg-white px-3 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                  [attr.aria-label]="'Book ' + specialist().name + ', ' + t.aria"
                  >{{ t.label }}</a
                >
              }
            </div>
          }

          <div class="flex flex-wrap items-center justify-between gap-x-4">
            <a
              [routerLink]="bookPath()"
              [queryParams]="calendarQuery()"
              class="inline-flex min-h-11 items-center gap-1 font-sans text-caption font-semibold text-cerulean hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
              [attr.aria-label]="'See ' + specialist().name + '’s full calendar'"
            >
              See full calendar <sd-icon name="arrow-right" [size]="14" />
            </a>
            @if (when().offerSimilar) {
              <button
                type="button"
                class="inline-flex min-h-11 items-center gap-1 font-sans text-caption font-semibold text-cerulean hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                [attr.aria-expanded]="similarOpen()"
                [attr.aria-controls]="similarId"
                (click)="similarOpen.set(!similarOpen())"
              >
                <sd-icon [name]="similarOpen() ? 'chevron-down' : 'users'" [size]="14" [class.rotate-180]="similarOpen()" />
                {{ similarOpen() ? 'Hide similar doctors' : similarLabel() }}
              </button>
            }
          </div>

          <div [id]="similarId">
            @if (similarOpen()) {
              <div class="border-t border-cloud pt-3">
                <pat-similar-doctors
                  [params]="similarParams()"
                  [heading]="date() ? 'Similar doctors free that day' : 'Similar doctors with openings'"
                />
              </div>
            }
          </div>
        </div>
      }

      <hr class="border-t border-cloud" />

      <!-- Footer: price + rating -->
      <div class="flex items-center justify-between gap-2">
        <span class="flex items-center gap-1.5 text-cerulean">
          <sd-icon name="info" [size]="16" />
          <span class="font-sans text-body-sm font-medium"
            >{{ fee() }} / Consultation</span
          >
        </span>
        <span
          class="flex items-center gap-1.5 font-sans text-caption text-slate"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="#f2a900">
            <path
              d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
            />
          </svg>
          {{ rating() }} ({{ specialist().reviews_count }} reviews)
        </span>
      </div>

      <!-- Actions -->
      <div class="mt-auto flex gap-3">
        <sd-button
          variant="outline"
          size="sm"
          [full]="true"
          (click)="profileOpen.set(true)"
        >
          View Profile
        </sd-button>
        <sd-button
          size="sm"
          [full]="true"
          [disabled]="!specialist().available"
          (click)="book()"
        >
          <sd-icon name="video" [size]="18" />
          Book Consultation
        </sd-button>
      </div>
    </article>

    <!-- Profile card pop-up -->
    <sd-dialog
      [open]="profileOpen()"
      layout="plain"
      size="lg"
      [labelledBy]="profileTitleId"
      (closed)="profileOpen.set(false)"
    >
      <div class="relative flex flex-col p-6 sm:p-8">
        <h2 [id]="profileTitleId" class="sr-only">{{ specialist().name }} — profile</h2>
        <button
          type="button"
          class="absolute right-3 top-3 z-10 inline-flex size-11 items-center justify-center rounded-full text-slate transition-colors hover:bg-glacier hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
          aria-label="Close"
          (click)="profileOpen.set(false)"
        >
          <sd-icon name="x" [size]="22" />
        </button>
        <sd-doctor-profile-card [data]="specialist()" [photoUrl]="photoSrc()" />
        <div class="mt-6 flex flex-col gap-2 border-t border-cloud pt-5">
          <span class="font-sans text-body-sm text-slate">Consultation fee: <span class="font-semibold text-ink">{{ fee() }}</span></span>
          <sd-button [full]="true" [disabled]="!specialist().available" (click)="profileOpen.set(false); book()">
            <sd-icon name="video" [size]="18" /> Book Consultation
          </sd-button>
        </div>
      </div>
    </sd-dialog>
  `,
})
export class SpecialistCard {
  private readonly specialistsApi = inject(SpecialistsApi);
  private readonly router = inject(Router);

  readonly specialist = input.required<SpecialistDto>();
  /** Optional "X% Match" badge (the Find-me-a-doctor results). Null hides it. */
  readonly matchPercent = input<number | null>(null);
  /** The day the directory is filtered on ('YYYY-MM-DD', the viewer's calendar), if any. */
  readonly date = input<string | null>(null);

  protected readonly profileOpen = signal(false);
  protected readonly similarOpen = signal(false);
  protected readonly similarId = `pat-card-similar-${++nextId}`;
  protected readonly profileTitleId = `pat-card-profile-${nextId}`;

  protected readonly bookPath = computed(() => ['/dashboard/appointments/book', this.specialist().id]);

  /** The listing's `availability`, worded: when, and up to three times to book. */
  protected readonly when = computed<WhenVm>(() => {
    const a = this.specialist().availability;
    const day = this.date();
    if (!a) return { title: 'Open the calendar to see times', detail: '', times: [], offerSimilar: false };
    if (day && (a.date !== day || a.open_slots === 0)) {
      // next_available_at counts from today, so it can come before the filtered day.
      const next = a.next_available_at;
      return {
        title: `Not free on ${shortDayLabel(day)}`,
        detail: !next
          ? 'No open times soon'
          : `${ymdInZone(next) < day ? 'Earliest' : 'Next'}: ${whenLabel(next)}`,
        times: [],
        offerSimilar: true,
      };
    }
    const first = a.first_slot_at ?? a.next_available_at;
    if (!first) return { title: 'No open times soon', detail: '', times: [], offerSimilar: true };
    return {
      title: day ? `Free on ${shortDayLabel(day)}` : 'Next available',
      detail: day ? `${a.open_slots} open ${a.open_slots === 1 ? 'time' : 'times'}` : whenLabel(first),
      times: a.slots_preview.slice(0, 3).map((iso) => ({ iso, label: slotLabel(iso), aria: whenLabel(iso) })),
      offerSimilar: false,
    };
  });

  /** The badge, from the next opening — never colour alone: it always says when. */
  protected readonly badge = computed(() => {
    const s = this.specialist();
    if (!s.available) return { label: 'Unavailable', class: 'bg-cloud text-slate' };
    if (!s.availability) return { label: 'Taking bookings', class: 'bg-sage/15 text-sage-ink' };
    const next = s.availability.next_available_at;
    if (!next) return { label: 'No openings soon', class: 'bg-cloud text-slate' };
    const day = ymdInZone(next);
    if (day === todayLocal()) return { label: 'Available today', class: 'bg-sage/15 text-sage-ink' };
    if (day === todayLocal(1)) return { label: 'Available tomorrow', class: 'bg-frost text-cerulean-dark' };
    return { label: `Next: ${shortDayLabel(day)}`, class: 'bg-frost text-cerulean-dark' };
  });

  /** The booking calendar opens on the filtered day when the doctor is free then. */
  protected readonly calendarQuery = computed(() => {
    const day = this.date();
    const a = this.specialist().availability;
    return day && a?.date === day && a.open_slots > 0 ? { date: day } : {};
  });

  protected readonly similarLabel = computed(() =>
    this.date() ? 'See similar doctors free that day' : 'See similar doctors',
  );

  protected readonly similarParams = computed<SpecialistSuggestionParams>(() => ({
    like: this.specialist().id,
    date: this.date() ?? todayLocal(),
    tz: viewerTimeZone(),
  }));

  protected readonly initials = computed(() =>
    this.specialist()
      .name.replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase(),
  );

  protected readonly rating = computed(() =>
    Number(this.specialist().rating).toFixed(1),
  );

  /** The specialist's headshot resolved to an absolute URL, or null (→ initials). */
  protected readonly photoSrc = computed(() =>
    this.specialistsApi.assetUrl(this.specialist().photo_url),
  );

  /** Consultation fee in Naira, thousands-separated (e.g. "₦15,000"). */
  protected readonly fee = computed(
    () =>
      '₦' +
      new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 }).format(
        Number(this.specialist().consultation_fee) || 0,
      ),
  );

  protected readonly about = computed(() => {
    const s = this.specialist();
    const parts = [
      `${s.name} is a ${s.specialty} specialist`,
      s.location ? ` based in ${s.location}` : '',
      s.years_experience
        ? ` with ${s.years_experience} years of experience`
        : '',
      '.',
    ];
    const langs = s.languages ? ` Speaks ${s.languages}.` : '';
    const rated = ` Rated ${this.rating()} from ${s.reviews_count} reviews.`;
    return parts.join('') + langs + rated;
  });

  /**
   * Browsing is public, booking needs an account. Everyone heads to the booking
   * calendar (a time link carries its `?slot=`). A visitor is intercepted by the
   * route guard, which remembers this exact URL — so after they sign in or
   * register they land back here with their selection intact.
   */
  protected book(): void {
    if (!this.specialist().available) return;
    void this.router.navigate(this.bookPath(), { queryParams: this.calendarQuery() });
  }
}
