import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { DoctorAppointmentDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { statusDetail, statusLook, type StatusLook } from './appointment-status';
import { doctorStatusLabel } from './follow-ups';

interface Filter {
  readonly key: string;
  readonly label: string;
  readonly status: string;
}

const FILTERS: Filter[] = [
  { key: 'all', label: 'All', status: '' },
  { key: 'completed', label: 'Completed', status: 'completed' },
  { key: 'missed', label: 'Missed', status: 'missed' },
  { key: 'cancelled', label: 'Cancelled', status: 'cancelled' },
];

/**
 * Doctor appointment history (route `/appointments/history`): every
 * consultation that is over — closed, or ended (`?when=past`, newest first),
 * whatever its status — filtered All / Completed / Missed / Cancelled. A past
 * booking that was never closed shows here as "Being finalised" / "Not
 * confirmed" until the reminders cron closes it.
 */
@Component({
  selector: 'doc-appointment-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Appointment History</h1>
        <p class="font-sans text-body text-slate">Review your past consultations.</p>
      </header>

      <!-- Filter bar (scrolls sideways on a narrow phone rather than wrapping). -->
      <div class="flex items-center gap-2 rounded-pill border border-haze bg-glacier px-1.5 py-1.5 shadow-bar sm:gap-4 sm:px-2">
        <div class="-m-1 flex min-w-0 flex-1 gap-1 overflow-x-auto rounded-pill p-1" role="group" aria-label="Filter by outcome">
          @for (f of filters; track f.key) {
            <button type="button"
              class="min-h-11 shrink-0 whitespace-nowrap rounded-pill px-3.5 py-2 font-sans text-body-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 sm:px-5"
              [class]="active() === f.key ? 'bg-frost text-cerulean-dark shadow-control' : 'text-slate hover:text-ink'"
              [attr.aria-pressed]="active() === f.key"
              (click)="select(f)">
              {{ f.label }}
            </button>
          }
        </div>
        <button type="button" class="min-h-11 shrink-0 pr-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean disabled:opacity-40 sm:pr-3" [disabled]="active() === 'all'" (click)="clearAll()">Clear<span class="hidden sm:inline">&nbsp;all</span></button>
      </div>

      @if (loading() && items().length === 0) {
        <div class="flex flex-col gap-3">
          <div class="sd-shimmer h-20 rounded-card"></div>
          <div class="sd-shimmer h-20 rounded-card"></div>
        </div>
      } @else if (error() && items().length === 0) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-haze bg-white py-16 text-center shadow-card">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
        </div>
      } @else if (items().length === 0) {
        <div class="flex flex-col items-center gap-3 py-16 text-center">
          <span class="flex size-20 items-center justify-center rounded-full bg-cloud/60 text-slate"><sd-icon name="history" [size]="34" /></span>
          <p class="font-sans text-body-sm text-slate">No past consultations{{ active() === 'all' ? '' : ' in this filter' }}.</p>
        </div>
      } @else {
        <ul class="flex flex-col gap-4">
          @for (a of items(); track a.id) {
            <li>
              <a [routerLink]="['/appointments', a.id]" class="flex flex-col gap-4 rounded-card border border-haze bg-white p-5 shadow-card transition hover:border-cerulean/40 hover:shadow-card-hover lg:flex-row lg:items-center lg:gap-6">
                <div class="flex min-w-0 flex-1 items-center gap-3">
                  <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-frost font-heading text-body-sm font-semibold text-cerulean-dark">{{ initialsFor(a.patient_name) }}</span>
                  <div class="flex min-w-0 flex-col">
                    <span class="truncate font-heading text-body-lg text-ink">{{ a.patient_name }}</span>
                    <span class="truncate font-sans text-body-sm text-slate">{{ a.type_label }}</span>
                  </div>
                </div>
                <div class="flex flex-col gap-1 lg:w-44">
                  <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="calendar-days" [size]="16" class="text-slate" />{{ dateLabel(a.scheduled_at) }}</span>
                  <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="clock" [size]="16" class="text-slate" />{{ time(a.scheduled_at) }}</span>
                </div>
                <div class="flex flex-col gap-1.5 lg:w-52">
                  <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="video" [size]="16" class="text-slate" />Video Consultation</span>
                  @let label = statusLabel(a);
                  @let look = statusLook(a);
                  <span class="inline-flex w-fit items-center gap-1 rounded-pill px-3 py-0.5 font-sans text-caption font-semibold inset-ring inset-ring-current/20" [class]="look.pill">
                    <sd-icon [name]="look.icon" [size]="13" />{{ label }}
                  </span>
                  <!-- Who didn't come, or why it never went ahead. -->
                  @if (detail(a, label); as d) {
                    <span class="font-sans text-caption text-slate">{{ d }}</span>
                  }
                </div>
                <sd-icon name="chevron-right" [size]="22" class="shrink-0 self-center text-slate" />
              </a>
            </li>
          }
        </ul>

        @if (error()) { <p class="text-center font-sans text-caption text-alert">{{ error() }}</p> }
        @if (hasMore()) {
          <button type="button" class="mx-auto rounded-field border border-haze bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:opacity-60 disabled:shadow-none" [disabled]="loading()" (click)="loadMore()">
            {{ loading() ? 'Loading…' : 'Load more' }}
          </button>
        }
      }
    </div>
  `,
})
export class DoctorAppointmentHistory implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly filters = FILTERS;
  protected readonly active = signal('all');
  protected readonly items = signal<DoctorAppointmentDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);
  protected readonly error = signal('');
  private page = 1;

  ngOnInit(): void {
    this.fetch();
  }

  protected select(f: Filter): void {
    if (this.active() === f.key) return;
    this.active.set(f.key);
    this.apply();
  }

  protected clearAll(): void {
    if (this.active() === 'all') return;
    this.active.set('all');
    this.apply();
  }

  private apply(): void {
    this.page = 1;
    this.items.set([]);
    this.fetch();
  }

  protected loadMore(): void {
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    this.error.set('');
    const status = this.filters.find((f) => f.key === this.active())?.status || undefined;
    this.api
      // Over only (the server's default, said explicitly): closed, or ended — newest first.
      .history({ page: this.page, per_page: 20, status, when: 'past' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          // Roll back a load-more page bump so the next click re-fetches this
          // page instead of skipping it, and surface the failure.
          if (this.page > 1) this.page -= 1;
          this.error.set(apiErrorMessage(err, 'Could not load your history. Please try again.'));
          this.loading.set(false);
        },
      });
  }

  protected initialsFor(name: string): string {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }
  protected statusLook(a: DoctorAppointmentDto): StatusLook {
    return statusLook(a);
  }
  /** How an unaccepted follow-up proposal closed, else the lifecycle label (Missed, Not confirmed…). */
  protected statusLabel(a: DoctorAppointmentDto): string {
    return doctorStatusLabel(a);
  }
  protected detail(a: DoctorAppointmentDto, label: string): string | null {
    return statusDetail(a, label);
  }
  protected dateLabel(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }
  protected time(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
}
