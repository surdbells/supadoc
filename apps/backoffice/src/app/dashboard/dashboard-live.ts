import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AdminDashboardLiveDto, AdminDashboardLiveItem } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { appointmentStatusClass } from '../shared/appointment-status';
import { LIST_CARD, LIST_CARD_BODY, LIST_CARD_HEAD, SECTION_TITLE } from '../shared/layout';
import { DashboardAvatar } from './dashboard-avatar';
import {
  GROUP_LABEL,
  HEAD_LINK,
  plural,
  ROW_LINK,
  startsIn,
  timeOf,
  timeRange,
} from './dashboard-ui';

/** Rows shown per group; the rest are behind "View all in monitoring". */
const SHOWN = 5;

interface Row {
  readonly item: AdminDashboardLiveItem;
  /** "with Ada Obi · Cardiology". */
  readonly sub: string;
  readonly when: string;
  /** "Both in the call" / "Patient waiting" … (in progress only). */
  readonly presence: { text: string; cls: string; icon: string } | null;
  readonly statusCls: string;
}

/**
 * "Live now": consultations someone is in right now, and open bookings
 * starting within the window (2 hours). Each row opens the appointment (or
 * monitoring for staff who can't open appointments).
 */
@Component({
  selector: 'bo-dash-live',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, DashboardAvatar],
  host: { class: 'flex min-w-0' },
  template: `
    <section class="${LIST_CARD} w-full" aria-labelledby="dash-live-title">
      <div class="${LIST_CARD_HEAD}">
        <div class="flex flex-wrap items-center gap-2">
          <h2 id="dash-live-title" class="${SECTION_TITLE}"><sd-icon name="video" [size]="20" class="text-cerulean" />Live now</h2>
          @if (live().in_progress_count > 0) {
            <span class="inline-flex items-center gap-1.5 rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-caption font-semibold text-ink inset-ring inset-ring-current/15">
              <span class="size-2 animate-pulse rounded-full bg-sage motion-reduce:animate-none" aria-hidden="true"></span>{{ live().in_progress_count }} in progress
            </span>
          }
        </div>
        <a routerLink="/monitoring" class="${HEAD_LINK}">Monitoring<sd-icon name="chevron-right" [size]="16" /></a>
      </div>

      <h3 class="${GROUP_LABEL}">In progress</h3>
      @if (inProgress().length === 0) {
        <p class="flex items-center gap-2 px-5 pb-4 pt-1 font-sans text-body-sm text-slate">
          <sd-icon name="video-off" [size]="16" class="shrink-0" />No consultations in progress right now.
        </p>
      } @else {
        <ul class="${LIST_CARD_BODY}">
          @for (r of inProgress(); track r.item.id) {
            <li>
              <a [routerLink]="link(r.item)" class="${ROW_LINK}">
                <bo-dash-avatar [name]="r.item.specialist.name" [photo]="r.item.specialist.photo_url" />
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ r.item.specialist.name }}</span>
                  <span class="truncate font-sans text-caption text-slate">{{ r.sub }}</span>
                </span>
                <span class="flex shrink-0 flex-col items-end gap-0.5">
                  @if (r.presence; as p) {
                    <span class="inline-flex items-center gap-1 font-sans text-caption font-semibold text-ink">
                      <sd-icon [name]="p.icon" [size]="13" [class]="p.cls" />{{ p.text }}
                    </span>
                  }
                  <span class="font-sans text-caption text-slate">{{ r.when }}</span>
                </span>
                <sd-icon name="chevron-right" [size]="18" class="shrink-0 text-slate" />
              </a>
            </li>
          }
        </ul>
        @if (live().in_progress_count > inProgress().length) {
          <a routerLink="/monitoring" class="${HEAD_LINK} mx-5 mb-3">+{{ live().in_progress_count - inProgress().length }} more in progress</a>
        }
      }

      <h3 class="${GROUP_LABEL} border-t border-cloud">Starting in the next {{ windowLabel() }}</h3>
      @if (startingSoon().length === 0) {
        <p class="flex items-center gap-2 px-5 pb-4 pt-1 font-sans text-body-sm text-slate">
          <sd-icon name="calendar-off" [size]="16" class="shrink-0" />Nothing starts in the next {{ windowLabel() }}.
        </p>
      } @else {
        <ul class="${LIST_CARD_BODY}">
          @for (r of startingSoon(); track r.item.id) {
            <li>
              <a [routerLink]="link(r.item)" class="${ROW_LINK}">
                <bo-dash-avatar [name]="r.item.specialist.name" [photo]="r.item.specialist.photo_url" />
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ r.item.specialist.name }}</span>
                  <span class="truncate font-sans text-caption text-slate">{{ r.sub }}</span>
                </span>
                <span class="flex shrink-0 flex-col items-end gap-0.5">
                  <span class="rounded-pill px-2 py-0.5 font-sans text-caption font-semibold inset-ring inset-ring-current/20" [class]="r.statusCls">{{ r.item.status_label }}</span>
                  <span class="font-sans text-caption text-slate">{{ r.when }}</span>
                </span>
                <sd-icon name="chevron-right" [size]="18" class="shrink-0 text-slate" />
              </a>
            </li>
          }
        </ul>
        @if (live().starting_soon_count > startingSoon().length) {
          <a routerLink="/monitoring" class="${HEAD_LINK} mx-5 mb-3">+{{ live().starting_soon_count - startingSoon().length }} more starting soon</a>
        }
      }
    </section>
  `,
})
export class DashboardLive {
  readonly live = input.required<AdminDashboardLiveDto>();
  /** Rows open the appointment (appointments.view), else monitoring. */
  readonly canOpenAppointments = input(false);

  protected readonly inProgress = computed<Row[]>(() =>
    this.live()
      .in_progress.slice(0, SHOWN)
      .map((item) => ({
        item,
        sub: subline(item),
        when: timeRange(item.scheduled_at, item.ends_at),
        presence: presenceOf(item),
        statusCls: appointmentStatusClass(item.status),
      })),
  );

  protected readonly startingSoon = computed<Row[]>(() => {
    const now = Date.now();
    return this.live()
      .starting_soon.slice(0, SHOWN)
      .map((item) => ({
        item,
        sub: subline(item),
        when: `${startsIn(item.scheduled_at, now)} · ${timeOf(item.scheduled_at)}`,
        presence: null,
        statusCls: appointmentStatusClass(item.status),
      }));
  });

  /** "2 hours" / "90 minutes". */
  protected readonly windowLabel = computed(() => {
    const m = this.live().window_minutes || 120;
    return m % 60 === 0 ? plural(m / 60, 'hour') : plural(m, 'minute');
  });

  protected link(item: AdminDashboardLiveItem): string | string[] {
    return this.canOpenAppointments() ? ['/appointments', item.id] : '/monitoring';
  }
}

function subline(item: AdminDashboardLiveItem): string {
  const specialty = (item.specialist.specialty ?? '').trim();
  return `with ${item.patient_name}` + (specialty ? ` · ${specialty}` : '');
}

/** Who is in the call, from staff's side, in words + an icon (the icon carries the colour). */
export function presenceOf(item: AdminDashboardLiveItem): Row['presence'] {
  const p = item.in_call;
  if (!p) return null;
  const guests = p.guests > 0 ? ` · +${plural(p.guests, 'guest')}` : '';
  if (p.doctor && p.patient) return { text: `Both in the call${guests}`, cls: 'text-sage', icon: 'user-check' };
  if (p.patient) return { text: `Patient waiting${guests}`, cls: 'text-warning', icon: 'hourglass' };
  if (p.doctor) return { text: `Doctor waiting${guests}`, cls: 'text-warning', icon: 'hourglass' };
  return guests ? { text: `Guests only${guests}`, cls: 'text-slate', icon: 'users' } : null;
}
