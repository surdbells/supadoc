import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AppointmentDto } from '@supadoc/models';
import { EmptyStateComponent, IconComponent } from '@supadoc/ui';
import { formatDay, formatTime, isUpcomingVisit, VisitStatusBadge } from './patient-record-ui';

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
      <div class="rounded-card border border-cloud bg-white">
        <sd-empty-state icon="calendar-off" title="No visits yet" message="Consultations with this patient will appear here." />
      </div>
    } @else {
      <ul class="flex flex-col gap-4">
        @for (r of rows(); track r.visit.id) {
          <li class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-colors hover:border-cerulean/40 lg:flex-row lg:items-center lg:gap-6">
            <div class="flex min-w-0 flex-1 items-center gap-3">
              <span class="flex size-12 shrink-0 items-center justify-center rounded-full" [class]="r.upcoming ? 'bg-frost text-cerulean' : 'bg-glacier text-slate'" aria-hidden="true">
                <sd-icon [name]="r.upcoming ? 'calendar-clock' : 'stethoscope'" [size]="20" />
              </span>
              <div class="flex min-w-0 flex-col">
                <span class="break-words font-heading text-body-lg text-ink">{{ r.visit.type_label }}</span>
                @if (r.visit.notes) {
                  <span class="line-clamp-2 break-words font-sans text-body-sm text-slate">{{ r.visit.notes }}</span>
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
              <div class="lg:w-36"><doc-visit-status-badge [status]="r.visit.status" [label]="r.visit.status_label" /></div>
              <a
                [routerLink]="['/appointments', r.visit.id]"
                class="inline-flex shrink-0 items-center gap-1 rounded-field border border-cloud px-4 py-2 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                [attr.aria-label]="'Open chart for ' + r.visit.type_label + ' on ' + r.day"
              >
                Open chart <sd-icon name="chevron-right" [size]="14" />
              </a>
            </div>
          </li>
        }
      </ul>
    }
  `,
})
export class PatientVisits {
  /** The patient's visits with this doctor, newest first. */
  readonly visits = input.required<AppointmentDto[]>();

  protected readonly rows = computed(() => {
    const now = Date.now();
    return this.visits().map((visit) => ({
      visit,
      upcoming: isUpcomingVisit(visit, now),
      day: formatDay(visit.scheduled_at),
      time: formatTime(visit.scheduled_at),
    }));
  });
}
