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
import {
  appointmentStatusClass,
  BTN_SECONDARY,
  CARD,
  dateTime,
  FIELD,
  FOCUS_RING,
  LABEL,
  money,
  PILL,
  plural,
} from '../specialist-ui';

const VIEWS: readonly { key: string; label: string; status?: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'upcoming', label: 'Booked', status: 'pending,confirmed,rescheduled' },
  { key: 'completed', label: 'Completed', status: 'completed' },
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
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div class="flex flex-wrap gap-2" role="group" aria-label="Appointment status">
          @for (v of views; track v.key) {
            <button
              type="button"
              [attr.aria-pressed]="view() === v.key"
              class="inline-flex min-h-11 items-center gap-1.5 rounded-pill px-3.5 py-2 font-sans text-body-sm transition-colors ${FOCUS_RING}"
              [class]="view() === v.key ? 'bg-cerulean text-white' : 'bg-white text-slate ring-1 ring-cloud hover:text-ink'"
              (click)="setView(v.key)"
            >
              @if (view() === v.key) { <sd-icon name="check" [size]="14" /> }{{ v.label }}
            </button>
          }
        </div>
        <label class="flex flex-col gap-1.5 sm:w-64">
          <span class="${LABEL}">Patient name</span>
          <input type="search" class="${FIELD} min-h-11" placeholder="Search patients" [value]="search()" (input)="onSearch($any($event.target).value)" />
        </label>
      </div>

      <p class="font-sans text-body-sm text-slate" aria-live="polite">
        @if (loading() && items().length === 0) { Loading appointments… } @else if (!error()) { {{ plural(total(), 'appointment') }} }
      </p>

      @if (error() && items().length === 0) {
        <div class="flex flex-col items-center gap-3 ${CARD} px-5 py-10 text-center">
          <sd-icon name="wifi-off" [size]="28" class="text-alert" />
          <p class="font-sans text-body-sm text-slate" role="alert">{{ error() }}</p>
          <button type="button" class="${BTN_SECONDARY}" (click)="reload()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
        </div>
      } @else if (loading() && items().length === 0) {
        <div class="sd-shimmer h-48 rounded-card" aria-hidden="true"></div>
      } @else {
        <ul class="flex flex-col divide-y divide-cloud ${CARD}">
          @for (a of items(); track a.id) {
            <li class="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div class="flex min-w-0 flex-col gap-0.5">
                @if (canOpen()) {
                  <a [routerLink]="['/appointments', a.id]" class="inline-flex min-h-11 w-fit items-center font-sans text-body-sm font-semibold text-ink hover:text-cerulean ${FOCUS_RING} sm:min-h-0">{{ a.patient_name || 'Patient' }}</a>
                } @else {
                  <span class="font-sans text-body-sm font-semibold text-ink">{{ a.patient_name || 'Patient' }}</span>
                }
                <span class="font-sans text-caption text-slate">{{ when(a.scheduled_at) }} · {{ a.type_label }}{{ a.parent_appointment_id ? ' · follow-up' : '' }}</span>
              </div>
              <div class="flex flex-wrap items-center gap-2 sm:justify-end">
                <span class="font-sans text-caption text-slate">{{ money(a.amount) }}{{ a.payment_status ? ' · ' + paymentLabel(a.payment_status) : '' }}</span>
                <span class="${PILL}" [class]="statusClass(a.status)">{{ a.status_label }}</span>
              </div>
            </li>
          } @empty {
            <li class="px-5 py-10 text-center font-sans text-body-sm text-slate">No appointments here.</li>
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

  protected statusClass(status: string): string {
    return appointmentStatusClass(status);
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
