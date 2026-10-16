import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AdminDashboardDoctorRow, AdminDashboardPeriod } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import {
  LIST_CARD,
  LIST_CARD_BODY,
  LIST_CARD_EMPTY,
  LIST_CARD_HEAD,
  LIST_HEAD,
  SECTION_SUBTITLE,
  SECTION_TITLE,
} from '../shared/layout';
import { DashboardAvatar } from './dashboard-avatar';
import { breakdownCaption, formatCount, formatMoney, HEAD_LINK, periodPhrase, plural } from './dashboard-ui';

/** md+ columns: Doctor | Consultations | (Revenue) | Rating | No-shows — header and rows share them. */
const COLS_MONEY = 'md:grid-cols-[minmax(0,1fr)_6.5rem_7rem_6rem_7.5rem]';
const COLS_PLAIN = 'md:grid-cols-[minmax(0,1fr)_6.5rem_6rem_7.5rem]';

/**
 * The doctors with the most completed consultations in the period:
 * consultations (of bookings), revenue (money permission only), rating and
 * no-shows on each side. A table-like list on md+, cards on a phone; each row
 * opens the doctor.
 */
@Component({
  selector: 'bo-dash-doctors',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, DashboardAvatar],
  host: { class: 'flex min-w-0' },
  template: `
    <section class="${LIST_CARD} w-full" aria-labelledby="dash-doctors-title">
      <div class="${LIST_CARD_HEAD}">
        <div class="flex min-w-0 flex-col">
          <h2 id="dash-doctors-title" class="${SECTION_TITLE}"><sd-icon name="award" [size]="20" class="text-cerulean" />Top doctors</h2>
          <span class="${SECTION_SUBTITLE}">{{ caption() }}</span>
        </div>
        <a routerLink="/specialists" class="${HEAD_LINK}">All doctors<sd-icon name="chevron-right" [size]="16" /></a>
      </div>

      @if (rows().length === 0) {
        <div class="${LIST_CARD_EMPTY}">
          <sd-icon name="stethoscope" [size]="28" class="text-slate" />
          <p class="font-sans text-body-sm text-slate">No consultations {{ phrase() }} yet.</p>
        </div>
      } @else {
        <div class="${LIST_HEAD}" [class]="cols()" aria-hidden="true">
          <span>Doctor</span>
          <span class="text-right">Consultations</span>
          @if (showRevenue()) { <span class="text-right">Revenue</span> }
          <span class="text-right">Rating</span>
          <span class="text-right">No-shows</span>
        </div>
        <ol class="${LIST_CARD_BODY}">
          @for (r of rows(); track r.id) {
            <li class="group relative flex flex-col gap-2 px-5 py-3.5 transition-colors hover:bg-glacier md:grid md:items-center md:gap-4" [class]="cols()">
              <!-- The row's link: its ::after covers the whole row (one tab stop, whole-row focus ring). -->
              <a
                [routerLink]="['/specialists', r.id]"
                class="flex min-w-0 items-center gap-3 after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-cerulean/40"
              >
                <span class="w-5 shrink-0 text-center font-sans text-caption font-semibold text-slate" aria-hidden="true">{{ r.rank }}</span>
                <bo-dash-avatar [name]="r.name" [photo]="r.photo" />
                <span class="flex min-w-0 flex-col">
                  <span class="truncate font-sans text-body-sm font-semibold text-ink group-hover:text-cerulean">{{ r.name }}</span>
                  <span class="truncate font-sans text-caption text-slate">{{ r.specialty }}</span>
                </span>
              </a>
              <div class="flex flex-wrap gap-x-4 gap-y-1 pl-8 md:contents">
                <span class="flex flex-col font-sans md:items-end">
                  <span class="text-body-sm font-semibold text-ink tabular-nums"><span class="font-normal text-slate md:sr-only">Consultations </span>{{ r.consultations }}</span>
                  <span class="text-caption text-slate">of {{ r.bookings }}</span>
                </span>
                @if (showRevenue()) {
                  <span class="font-sans text-body-sm font-semibold text-ink tabular-nums md:text-right"><span class="font-normal text-slate md:sr-only">Revenue </span>{{ r.revenue }}</span>
                }
                <span class="flex flex-col font-sans md:items-end">
                  <span class="inline-flex items-center gap-1 text-body-sm font-semibold text-ink tabular-nums">
                    <span class="font-normal text-slate md:sr-only">Rating </span><sd-icon name="star" [size]="14" class="text-warning" />{{ r.rating }}
                  </span>
                  <span class="text-caption text-slate">{{ r.reviews }}</span>
                </span>
                <span class="flex flex-col font-sans text-caption md:items-end">
                  <span class="md:sr-only text-slate">No-shows</span>
                  <span class="inline-flex items-center gap-1" [class]="r.doctorNoShows > 0 ? 'font-semibold text-ink' : 'text-slate'">
                    @if (r.doctorNoShows > 0) { <sd-icon name="triangle-alert" [size]="13" class="text-alert" /> }Doctor {{ r.doctorNoShows }}
                  </span>
                  <span class="text-slate">Patient {{ r.patientNoShows }}</span>
                </span>
              </div>
            </li>
          }
        </ol>
      }
    </section>
  `,
})
export class DashboardDoctors {
  readonly doctors = input.required<readonly AdminDashboardDoctorRow[]>();
  readonly period = input.required<AdminDashboardPeriod>();
  readonly currency = input('NGN');

  protected readonly caption = computed(() => `${breakdownCaption(this.period())}, by completed consultations`);
  protected readonly phrase = computed(() => (this.period() === 'today' ? 'today' : periodPhrase(this.period())));
  /** Revenue only came back for a money permission. */
  protected readonly showRevenue = computed(() => this.doctors().some((d) => d.revenue !== null));
  protected readonly cols = computed(() => (this.showRevenue() ? COLS_MONEY : COLS_PLAIN));

  protected readonly rows = computed(() =>
    this.doctors().map((d, i) => {
      const rating = Number(d.rating);
      return {
        id: d.id,
        rank: i + 1,
        name: d.name,
        specialty: d.specialty || '—',
        photo: d.photo_url,
        consultations: formatCount(d.consultations),
        bookings: plural(d.bookings, 'booking'),
        revenue: formatMoney(d.revenue, this.currency()),
        rating: d.reviews_count > 0 && Number.isFinite(rating) ? rating.toFixed(2) : '—',
        reviews: d.reviews_count > 0 ? plural(d.reviews_count, 'review') : 'No reviews',
        doctorNoShows: d.doctor_no_shows || 0,
        patientNoShows: d.patient_no_shows || 0,
      };
    }),
  );
}
