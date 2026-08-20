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
import { Router } from '@angular/router';
import { SpecialistsApi } from '@supadoc/data-access';
import type { DayAvailability, SpecialistDto } from '@supadoc/models';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

/**
 * One specialist in the directory (Figma 311:4126) with an inline date/time
 * picker driven by the specialist's real availability
 * (GET /portal/specialists/{id}/slots). Choosing a day + slot and hitting Book
 * Consultation creates the appointment and jumps to My Appointments.
 */
@Component({
  selector: 'pat-specialist-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <article
      class="flex h-full flex-col gap-4 rounded-card border border-cloud bg-white p-6 shadow-[0_1px_3px_rgba(10,22,40,0.06)] transition-colors duration-200 hover:border-cerulean/50 hover:bg-frost/20"
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
              class="flex size-11 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-body-sm font-semibold text-cerulean"
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
            class="rounded-pill px-3 py-1 font-sans text-[10px] font-medium"
            [class]="availability().class"
          >
            {{ availability().label }}
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

      <!-- Scheduling widget -->
      @if (!specialist().available) {
        <div
          class="flex items-center gap-2 rounded-card border border-cloud bg-glacier/60 px-4 py-3 font-sans text-caption text-slate"
        >
          <sd-icon name="calendar-off" [size]="16" />
          Not accepting bookings right now.
        </div>
      } @else if (loadingSlots()) {
        <div
          class="sd-shimmer h-28 rounded-card"
        ></div>
      } @else if (days().length === 0) {
        <div
          class="flex items-center gap-2 rounded-card border border-cloud bg-glacier/60 px-4 py-3 font-sans text-caption text-slate"
        >
          <sd-icon name="calendar-off" [size]="16" />
          No open slots in the next two weeks.
        </div>
      } @else {
        <div
          class="flex flex-col gap-3 rounded-card border border-cloud bg-glacier/60 p-4"
        >
          <div class="flex items-center justify-between gap-2">
            <span
              class="flex items-center gap-1.5 font-sans text-caption font-semibold text-cerulean"
            >
              <sd-icon name="calendar-clock" [size]="16" />Next Available
            </span>
            <span class="font-sans text-caption font-medium text-ink">{{
              selectedSummary()
            }}</span>
          </div>

          <!-- Collapsible calendar -->
          <button
            type="button"
            class="flex items-center justify-center gap-1 font-sans text-caption font-semibold text-cerulean transition-colors hover:text-cerulean-dark"
            [attr.aria-expanded]="calendarOpen()"
            (click)="calendarOpen.set(!calendarOpen())"
          >
            {{ calendarOpen() ? 'hide calendar' : 'view calendar' }}
            <sd-icon
              name="chevron-down"
              [size]="16"
              class="transition-transform"
              [class.rotate-180]="calendarOpen()"
            />
          </button>

          @if (calendarOpen()) {
            <!-- Dates -->
            <div class="flex gap-2 overflow-x-auto pb-1">
              @for (d of days(); track d.date) {
                <button
                  type="button"
                  class="flex shrink-0 flex-col items-center rounded-field border px-3 py-1.5 transition-colors"
                  [class]="
                    selectedDate() === d.date
                      ? 'border-cerulean bg-cerulean text-white'
                      : 'border-cloud bg-white text-slate hover:border-cerulean/50'
                  "
                  (click)="pickDate(d)"
                >
                  <span class="font-sans text-[10px] uppercase">{{
                    d.weekday
                  }}</span>
                  <span class="font-sans text-body-sm font-semibold">{{
                    d.day
                  }}</span>
                </button>
              }
            </div>

            <!-- Times -->
            <div class="flex flex-wrap gap-2">
              @for (t of selectedDaySlots(); track t.iso) {
                <button
                  type="button"
                  class="rounded-field border px-3 py-1 font-sans text-caption transition-colors"
                  [class]="
                    selectedTime() === t.iso
                      ? 'border-cerulean bg-cerulean text-white'
                      : 'border-cloud bg-white text-slate hover:border-cerulean/50'
                  "
                  (click)="selectedTime.set(t.iso)"
                >
                  {{ t.label }}
                </button>
              }
            </div>
          }
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

      <!-- About (View Profile) -->
      @if (showAbout()) {
        <p class="font-sans text-body-sm leading-relaxed text-slate">
          {{ about() }}
        </p>
      }

      <!-- Actions -->
      <div class="mt-auto flex gap-3">
        <sd-button
          variant="outline"
          size="sm"
          [full]="true"
          (click)="showAbout.set(!showAbout())"
        >
          {{ showAbout() ? 'Hide Profile' : 'View Profile' }}
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
  `,
})
export class SpecialistCard implements OnInit {
  private readonly specialistsApi = inject(SpecialistsApi);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly specialist = input.required<SpecialistDto>();
  /** Optional "X% Match" badge (the Find-me-a-doctor results). Null hides it. */
  readonly matchPercent = input<number | null>(null);

  protected readonly showAbout = signal(false);

  protected readonly days = signal<DayAvailability[]>([]);
  protected readonly loadingSlots = signal(true);
  protected readonly calendarOpen = signal(false);
  protected readonly selectedDate = signal('');
  protected readonly selectedTime = signal('');

  ngOnInit(): void {
    if (!this.specialist().available) {
      this.loadingSlots.set(false);
      return;
    }
    this.specialistsApi
      .slots(this.specialist().id, 7)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.days.set(res.data);
          const first = res.data[0];
          if (first) {
            this.selectedDate.set(first.date);
            this.selectedTime.set(first.slots[0]?.iso ?? '');
          }
          this.loadingSlots.set(false);
        },
        error: () => this.loadingSlots.set(false),
      });
  }

  protected readonly selectedDaySlots = computed(
    () => this.days().find((d) => d.date === this.selectedDate())?.slots ?? [],
  );

  protected pickDate(d: DayAvailability): void {
    this.selectedDate.set(d.date);
    this.selectedTime.set(d.slots[0]?.iso ?? '');
  }

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

  protected readonly availability = computed(() =>
    this.specialist().available
      ? { label: 'Available Today', class: 'bg-sage/15 text-sage' }
      : { label: 'Unavailable', class: 'bg-cloud text-slate' },
  );

  protected readonly selectedSummary = computed(() => {
    const day = this.days().find((d) => d.date === this.selectedDate());
    const slot = day?.slots.find((s) => s.iso === this.selectedTime());
    return day && slot ? `${day.weekday} ${day.day}, ${slot.label}` : '';
  });

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
   * wizard (carrying the picked slot). A visitor is intercepted by the route
   * guard, which remembers this exact URL — so after they sign in or register
   * they land back here with their selection intact.
   */
  protected book(): void {
    if (!this.specialist().available) return;
    void this.router.navigate(
      ['/dashboard/appointments/book', this.specialist().id],
      this.selectedTime() ? { queryParams: { slot: this.selectedTime() } } : {},
    );
  }
}
