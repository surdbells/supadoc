import { inject, ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AppointmentDto } from '@supadoc/models';
import { EmptyStateComponent, IconComponent } from '@supadoc/ui';
import { statusDetail, statusKey } from '../appointment/appointment-status';
import { doctorStatusLabel } from '../appointment/follow-ups';
import { formatDay, formatTime, isUpcomingVisit, VisitStatusBadge } from './patient-record-ui';
import { DoctorClock } from '../doctor-clock';

/**
 * The patient record's Visits tab: every consultation with this doctor, newest
 * first (styled like Schedule Details' Past Visits), each opening its chart.
 */
@Component({
  selector: 'doc-patient-visits',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, EmptyStateComponent, IconComponent, VisitStatusBadge],
  host: { class: 'block' },
  template: `
    @if (rows().length === 0) {
      <div class="rounded-card border border-haze bg-white shadow-card">
        <sd-empty-state icon="calendar-off" title="No visits yet" message="Consultations with this patient will appear here." />
      </div>
    } @else {
      <ul class="flex flex-col gap-4">
        @for (r of rows(); track r.visit.id) {
          <li class="flex flex-col gap-4 rounded-card border border-haze bg-white p-5 shadow-card transition hover:border-cerulean/40 lg:flex-row lg:items-center lg:gap-6">
            <div class="flex min-w-0 flex-1 items-center gap-3">
              <span class="flex size-12 shrink-0 items-center justify-center rounded-full" [class]="r.upcoming ? 'bg-frost text-cerulean-dark' : 'bg-glacier text-slate'" aria-hidden="true">
                <sd-icon [name]="r.upcoming ? 'calendar-clock' : 'stethoscope'" [size]="20" />
              </span>
              <div class="flex min-w-0 flex-col">
                <span class="break-words font-heading text-body-lg text-ink">{{ r.visit.type_label }}</span>
                @if (r.visit.notes) {
                  <span class="line-clamp-2 break-words font-sans text-body-sm text-slate">{{ r.visit.notes }}</span>
                } @else if (r.visit.status === 'proposed') {
                  <span class="font-sans text-body-sm text-slate">Follow-up you proposed — not booked until the patient accepts</span>
                } @else {
                  <span class="font-sans text-body-sm text-slate">{{ r.upcoming ? 'Upcoming consultation' : 'Consultation' }}</span>
                }
              </div>
            </div>
            <div class="flex flex-wrap gap-x-5 gap-y-1 lg:w-48 lg:flex-col">
              <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="calendar-days" [size]="16" class="shrink-0 text-slate" />{{ r.day }}</span>
              <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="clock" [size]="16" class="shrink-0 text-slate" />{{ r.time }}</span>
            </div>
            <div class="flex items-center justify-between gap-3 lg:w-auto lg:justify-end lg:gap-6">
              <div class="flex flex-col gap-1 lg:w-36">
                <doc-visit-status-badge [status]="r.key" [label]="r.label" />
                @if (r.detail) { <span class="font-sans text-caption text-slate">{{ r.detail }}</span> }
                @if (chartMode() === 'drill' && r.visit.id === currentId()) {
                  <span class="sd-chip sd-tag w-fit bg-frost text-cerulean-dark">This consultation</span>
                }
              </div>
              @if (chartMode() === 'drill') {
                <button
                  type="button"
                  [attr.data-visit-id]="r.visit.id"
                  class="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-field border border-haze bg-white px-4 py-2 font-sans text-caption font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                  [attr.aria-label]="'View visit: ' + r.visit.type_label + ' on ' + r.day"
                  (click)="openVisit.emit(r.visit)"
                >
                  View visit <sd-icon name="chevron-right" [size]="14" />
                </button>
              } @else {
                <a
                  [routerLink]="['/appointments', r.visit.id]"
                  class="inline-flex shrink-0 items-center gap-1 rounded-field border border-haze bg-white px-4 py-2 font-sans text-caption font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                  [attr.aria-label]="'Open chart for ' + r.visit.type_label + ' on ' + r.day"
                >
                  Open chart <sd-icon name="chevron-right" [size]="14" />
                </a>
              }
            </div>
          </li>
        }
      </ul>
    }
  `,
})
export class PatientVisits {
  /** The doctor's clock (their profile time zone): every time shown here. */
  protected readonly clock = inject(DoctorClock);
  /** The patient's visits with this doctor, newest first. */
  readonly visits = input.required<AppointmentDto[]>();
  /** 'link': "Open chart" router links (the /patients/:id page). 'drill': "View visit" buttons that emit (the call's EMR). */
  readonly chartMode = input<'link' | 'drill'>('link');
  readonly openVisit = output<AppointmentDto>();
  /** Drill mode: the consultation this call is (its row says "This consultation"). */
  readonly currentId = input<string | null>(null);

  protected readonly rows = computed(() => {
    const now = Date.now();
    return this.visits().map((visit) => {
      // "Awaiting patient" for a follow-up proposal, how an unaccepted one closed, else the lifecycle label.
      const label = doctorStatusLabel(visit, now);
      return {
        visit,
        upcoming: isUpcomingVisit(visit, now),
        key: statusKey(visit),
        label,
        // "Patient didn't join", "You didn't confirm in time"…
        detail: statusDetail(visit, label),
        day: formatDay(visit.scheduled_at, this.clock.zone()),
        time: formatTime(visit.scheduled_at, this.clock.zone()),
      };
    });
  });
}
