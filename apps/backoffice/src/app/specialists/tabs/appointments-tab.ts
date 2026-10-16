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
import { RouterLink } from '@angular/router';
import type { Subscription } from 'rxjs';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type { SpecialistAppointmentRowDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { appointmentBadge, AppointmentBadge, ATTENTION_BADGE } from '../../shared/appointment-status';
import {
  AVATAR_SM,
  CARD_RAISED,
  FILTER_CHIP,
  FILTER_CHIP_OFF,
  FILTER_CHIP_ON,
  FILTER_CHIPS,
  INLINE_ERROR,
  LIST_CARD_EMPTY,
  PANEL_STATE,
  SEARCH_BOX,
  SEARCH_CLEAR,
  SEARCH_ICON,
  SEARCH_INPUT,
} from '../../shared/layout';
import { BTN_SECONDARY, dateTime, FOCUS_RING, initials, money, PILL, plural } from '../specialist-ui';

const VIEWS: readonly { key: string; label: string; status?: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'upcoming', label: 'Booked', status: 'pending,confirmed,rescheduled' },
  { key: 'completed', label: 'Completed', status: 'completed' },
  // Closed with someone absent — the badge's detail says who.
  { key: 'missed', label: 'Missed', status: 'missed' },
  { key: 'cancelled', label: 'Cancelled', status: 'cancelled' },
  { key: 'proposed', label: 'Follow-up proposals', status: 'proposed' },
];

const PER_PAGE = 20;

const PAYMENT: Record<string, string> = {
  unpaid: 'Unpaid',
  pending: 'Payment pending',
  paid: 'Paid',
  refunded: 'Refunded',
};

/**
 * The doctor page's Appointments tab: their consultations, newest first, by
 * status and patient name (names only — no patient contact details). Rows open
 * the appointment for staff who may view appointments.
 */
@Component({
  selector: 'bo-specialist-appointments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  template: `
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div class="${FILTER_CHIPS}" role="group" aria-label="Appointment status">
          @for (v of views; track v.key) {
            <button
              type="button"
              [attr.aria-pressed]="view() === v.key"
              class="${FILTER_CHIP}"
              [class]="view() === v.key ? '${FILTER_CHIP_ON}' : '${FILTER_CHIP_OFF}'"
              (click)="setView(v.key)"
            >
              @if (view() === v.key) { <sd-icon name="check" [size]="14" /> }{{ v.label }}
            </button>
          }
        </div>
        <div role="search" class="w-full lg:max-w-xs">
          <label for="bo-sp-appt-search" class="sr-only">Search by patient name</label>
          <div class="${SEARCH_BOX}">
            <sd-icon name="search" [size]="20" class="${SEARCH_ICON}" />
            <input id="bo-sp-appt-search" type="search" autocomplete="off" class="${SEARCH_INPUT}" placeholder="Search by patient name…" [value]="search()" (input)="onSearch($any($event.target).value)" (keydown.escape)="search() && onSearch('')" />
            @if (search()) {
              <button type="button" class="${SEARCH_CLEAR}" aria-label="Clear search" (click)="onSearch('')"><sd-icon name="x" [size]="16" /></button>
            }
          </div>
        </div>
      </div>

      <p class="font-sans text-body-sm text-slate" aria-live="polite">
        @if (loading() && items().length === 0) { Loading appointments… } @else if (!error()) { {{ plural(total(), 'appointment') }} }
      </p>

      @if (error() && items().length === 0) {
        <div class="${PANEL_STATE}">
          <sd-icon name="wifi-off" [size]="28" class="text-alert" />
          <p class="font-sans text-body-sm text-slate" role="alert">{{ error() }}</p>
          <button type="button" class="${BTN_SECONDARY}" (click)="reload()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
        </div>
      } @else if (loading() && items().length === 0) {
        <div class="sd-shimmer h-48 rounded-card" aria-hidden="true"></div>
      } @else {
        <ul class="flex flex-col divide-y divide-cloud ${CARD_RAISED}">
          @for (a of items(); track a.id) {
            <li class="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div class="flex min-w-0 items-center gap-3">
              <span class="${AVATAR_SM}" aria-hidden="true">{{ initials(a.patient_name || 'Patient') }}</span>
              <div class="flex min-w-0 flex-col gap-0.5">
                @if (canOpen()) {
                  <a [routerLink]="['/appointments', a.id]" class="inline-flex min-h-11 w-fit items-center font-sans text-body-sm font-semibold text-ink hover:text-cerulean ${FOCUS_RING} sm:min-h-0">{{ a.patient_name || 'Patient' }}</a>
                } @else {
                  <span class="font-sans text-body-sm font-semibold text-ink">{{ a.patient_name || 'Patient' }}</span>
                }
                <span class="font-sans text-caption text-slate">{{ when(a.scheduled_at) }} · {{ a.type_label }}{{ a.parent_appointment_id ? ' · follow-up' : '' }}</span>
              </div>
              </div>
              <div class="flex flex-wrap items-center gap-2 sm:justify-end">
                <span class="font-sans text-caption text-slate">{{ money(a.amount) }}{{ a.payment_status ? ' · ' + paymentLabel(a.payment_status) : '' }}</span>
                @if (badge(a); as b) {
                  <span class="${PILL}" [class]="b.cls"><sd-icon [name]="b.icon" [size]="13" />{{ b.label }}</span>
                  @if (a.needs_attention) {
                    <span class="${PILL} ${ATTENTION_BADGE.cls}"><sd-icon name="${ATTENTION_BADGE.icon}" [size]="13" />{{ attention.label }}</span>
                  }
                  @if (b.detail) {
                    <span class="w-full font-sans text-caption text-slate sm:w-auto">{{ b.detail }}</span>
                  }
                }
              </div>
            </li>
          } @empty {
            <li class="${LIST_CARD_EMPTY}"><sd-icon name="calendar-off" [size]="28" class="text-slate" /><p class="font-sans text-body-sm text-slate">No appointments here.</p></li>
          }
        </ul>
        @if (error()) {
          <p class="${INLINE_ERROR} mx-auto w-fit" role="alert"><sd-icon name="circle-alert" [size]="16" class="shrink-0" />{{ error() }}</p>
        }
        @if (hasMore()) {
          <button type="button" class="${BTN_SECONDARY} mx-auto" [disabled]="loading()" (click)="loadMore()">{{ loading() ? 'Loading…' : 'Load more' }}</button>
        }
      }
    </div>
  `,
})
export class SpecialistAppointmentsTab {
  private readonly api = inject(SpecialistsApi);
  private readonly auth = inject(StaffAuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly specialistId = input.required<string>();
  /** Bumped by the page after a change (e.g. a suspension cancelled bookings). */
  readonly version = input(0);

  protected readonly views = VIEWS;
  protected readonly view = signal('all');
  protected readonly search = signal('');
  protected readonly items = signal<SpecialistAppointmentRowDto[]>([]);
  protected readonly total = signal(0);
  protected readonly hasMore = signal(false);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly canOpen = computed(() => this.auth.hasPermission('appointments.view'));
  private page = 1;
  private sub?: Subscription;
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => {
      this.specialistId();
      this.version();
      untracked(() => this.reload());
    });
  }

  protected setView(key: string): void {
    this.view.set(key);
    this.reload();
  }

  protected onSearch(term: string): void {
    this.search.set(term);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reload(), 300);
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
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    const status = VIEWS.find((v) => v.key === this.view())?.status;
    const search = this.search().trim();
    this.sub = this.api
      .doctorAppointments(this.specialistId(), { page: this.page, per_page: PER_PAGE, status, search: search || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.total.set(res.meta?.total ?? res.data.length);
          this.hasMore.set((res.meta?.page ?? 1) < (res.meta?.total_pages ?? 1));
          this.loading.set(false);
        },
        error: (err: unknown) => {
          if (this.page > 1) this.page -= 1;
          else this.items.set([]);
          this.error.set(apiErrorMessage(err, "Could not load this doctor's appointments."));
          this.loading.set(false);
        },
      });
  }

  /** The patient's initials for the row avatar. */
  protected readonly initials = initials;

  /** The server's display label (Missed, Not confirmed, Being finalised…) and its staff-worded detail. */
  protected readonly attention = ATTENTION_BADGE;
  protected badge(a: SpecialistAppointmentRowDto): AppointmentBadge {
    return appointmentBadge(a);
  }
  protected when(iso: string): string {
    return dateTime(iso);
  }
  protected money(amount: string): string {
    return money(amount);
  }
  protected paymentLabel(status: string): string {
    return PAYMENT[status] ?? status;
  }
  protected plural(n: number, word: string): string {
    return plural(n, word);
  }
}
