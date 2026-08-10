import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AppointmentsApi } from '@supadoc/data-access';
import type { SpecialistDto } from '@supadoc/models';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

interface DateOption {
  readonly value: string; // YYYY-MM-DD
  readonly weekday: string; // Tue
  readonly day: string; // 11
}

interface TimeOption {
  readonly value: string; // HH:MM (24h)
  readonly label: string; // 10:00 AM
}

// A fixed daily set of bookable slots (no per-doctor calendar in the backend
// yet — these are the times a patient can request).
const SLOTS: TimeOption[] = [
  { value: '09:00', label: '9:00 AM' },
  { value: '10:00', label: '10:00 AM' },
  { value: '11:00', label: '11:00 AM' },
  { value: '14:00', label: '2:00 PM' },
  { value: '15:00', label: '3:00 PM' },
  { value: '16:00', label: '4:00 PM' },
];

/**
 * One specialist in the directory (Figma 311:4126) with an inline date/time
 * picker. Choosing a day + slot and hitting Book Consultation creates the
 * appointment via POST /portal/appointments and jumps to My Appointments.
 */
@Component({
  selector: 'pat-specialist-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <article
      class="flex h-full flex-col gap-4 rounded-card border border-cloud bg-white p-6 shadow-[0_1px_3px_rgba(10,22,40,0.06)]"
    >
      <!-- Header -->
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          <span
            class="flex size-11 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-body-sm font-semibold text-cerulean"
          >
            {{ initials() }}
          </span>
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
        <span
          class="shrink-0 rounded-pill px-3 py-1 font-sans text-[10px] font-medium"
          [class]="availability().class"
        >
          {{ availability().label }}
        </span>
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
      @if (specialist().available) {
        <div class="flex flex-col gap-3 rounded-card border border-cloud bg-glacier/60 p-4">
          <div class="flex items-center justify-between gap-2">
            <span
              class="flex items-center gap-1.5 font-sans text-caption font-semibold text-cerulean"
            >
              <sd-icon name="calendar-clock" [size]="16" />Choose a time
            </span>
            <span class="font-sans text-caption font-medium text-ink">{{
              selectedSummary()
            }}</span>
          </div>

          <!-- Dates -->
          <div class="flex gap-2 overflow-x-auto pb-1">
            @for (d of dates; track d.value) {
              <button
                type="button"
                class="flex shrink-0 flex-col items-center rounded-field border px-3 py-1.5 transition-colors"
                [class]="
                  selectedDate() === d.value
                    ? 'border-cerulean bg-cerulean text-white'
                    : 'border-cloud bg-white text-slate hover:border-cerulean/50'
                "
                (click)="selectedDate.set(d.value)"
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
            @for (t of slots; track t.value) {
              <button
                type="button"
                class="rounded-field border px-3 py-1 font-sans text-caption transition-colors"
                [class]="
                  selectedTime() === t.value
                    ? 'border-cerulean bg-cerulean text-white'
                    : 'border-cloud bg-white text-slate hover:border-cerulean/50'
                "
                (click)="selectedTime.set(t.value)"
              >
                {{ t.label }}
              </button>
            }
          </div>
        </div>
      } @else {
        <div
          class="flex items-center gap-2 rounded-card border border-cloud bg-glacier/60 px-4 py-3 font-sans text-caption text-slate"
        >
          <sd-icon name="calendar-off" [size]="16" />
          Not accepting bookings right now.
        </div>
      }

      @if (bookError()) {
        <p
          class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert"
        >
          {{ bookError() }}
        </p>
      }

      <hr class="border-t border-cloud" />

      <!-- Footer: price + rating -->
      <div class="flex items-center justify-between gap-2">
        <span class="flex items-center gap-1.5 text-cerulean">
          <sd-icon name="info" [size]="16" />
          <span class="font-sans text-body-sm font-medium"
            >\${{ specialist().consultation_fee }} / Consultation</span
          >
        </span>
        <span class="flex items-center gap-1.5 font-sans text-caption text-slate">
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
          [disabled]="!specialist().available || booking()"
          (click)="book()"
        >
          <sd-icon name="video" [size]="18" />
          {{ booking() ? 'Booking…' : 'Book Consultation' }}
        </sd-button>
      </div>
    </article>
  `,
})
export class SpecialistCard {
  private readonly appointments = inject(AppointmentsApi);
  private readonly router = inject(Router);

  readonly specialist = input.required<SpecialistDto>();

  protected readonly showAbout = signal(false);
  protected readonly booking = signal(false);
  protected readonly bookError = signal('');

  protected readonly slots = SLOTS;
  // Next 6 bookable days, starting tomorrow.
  protected readonly dates: DateOption[] = ((): DateOption[] => {
    const out: DateOption[] = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = 1; i <= 6; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      const pad = (n: number): string => String(n).padStart(2, '0');
      out.push({
        value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
        day: String(d.getDate()),
      });
    }
    return out;
  })();

  protected readonly selectedDate = signal(this.dates[0].value);
  protected readonly selectedTime = signal(SLOTS[0].value);

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

  protected readonly availability = computed(() =>
    this.specialist().available
      ? { label: 'Available Today', class: 'bg-sage/15 text-sage' }
      : { label: 'Unavailable', class: 'bg-cloud text-slate' },
  );

  protected readonly selectedSummary = computed(() => {
    const d = this.dates.find((o) => o.value === this.selectedDate());
    const t = this.slots.find((o) => o.value === this.selectedTime());
    return d && t ? `${d.weekday} ${d.day}, ${t.label}` : '';
  });

  protected readonly about = computed(() => {
    const s = this.specialist();
    const parts = [
      `${s.name} is a ${s.specialty} specialist`,
      s.location ? ` based in ${s.location}` : '',
      s.years_experience ? ` with ${s.years_experience} years of experience` : '',
      '.',
    ];
    const langs = s.languages ? ` Speaks ${s.languages}.` : '';
    const rated = ` Rated ${this.rating()} from ${s.reviews_count} reviews.`;
    return parts.join('') + langs + rated;
  });

  protected async book(): Promise<void> {
    const s = this.specialist();
    if (!s.available) return;
    this.booking.set(true);
    this.bookError.set('');
    try {
      const iso = new Date(
        `${this.selectedDate()}T${this.selectedTime()}:00`,
      ).toISOString();
      await firstValueFrom(
        this.appointments.book({
          specialist_id: s.id,
          scheduled_at: iso,
          type: 'video',
        }),
      );
      await this.router.navigate(['/dashboard/appointments']);
    } catch (err) {
      this.bookError.set(
        (err as { message?: string })?.message ??
          'Could not book this consultation. Try again.',
      );
    } finally {
      this.booking.set(false);
    }
  }
}
