import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { DoctorApplicationDetailDto, DoctorApplicationEventDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { SECTION, SECTION_TITLE } from '../../shared/layout';
import { dateTime } from '../../specialists/specialist-ui';
import { applicationStatusBadge, eventIcon, isNotificationEvent } from '../application-ui';

const CHANNEL: Record<string, string> = { email: 'Email', sms: 'SMS' };

/**
 * Everything that happened to the application, newest first: status changes
 * (who and when, and what the applicant was told), requests and replies,
 * interviews, and each email or text sent — or that failed — by channel.
 * The emails and texts can be hidden to read the decisions alone.
 */
@Component({
  selector: 'bo-application-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <section class="${SECTION} !gap-4" aria-labelledby="bo-app-timeline-title">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="bo-app-timeline-title" class="${SECTION_TITLE}"><sd-icon name="history" [size]="20" class="text-cerulean" />Timeline</h2>
        <label class="flex min-h-11 cursor-pointer items-center gap-2 font-sans text-body-sm text-ink">
          <input type="checkbox" class="size-5 accent-cerulean" [checked]="hideSends()" (change)="hideSends.set($any($event.target).checked)" />
          Hide emails and texts
        </label>
      </div>
      <ol class="flex flex-col divide-y divide-cloud">
        @for (e of events(); track e.id) {
          <li class="flex gap-3 py-3">
            <span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full" [class]="tone(e)" aria-hidden="true">
              <sd-icon [name]="icon(e)" [size]="14" />
            </span>
            <div class="flex min-w-0 flex-col gap-0.5">
              <span class="font-sans text-body-sm font-semibold text-ink">{{ title(e) }}</span>
              <span class="font-sans text-caption text-slate">{{ when(e.created_at) }} · {{ actor(e) }}{{ e.applicant_visible ? ' · shown to the applicant' : '' }}</span>
              @if (e.public_message) {
                <span class="whitespace-pre-line break-words font-sans text-caption text-ink">{{ e.public_message }}</span>
              }
            </div>
          </li>
        } @empty {
          <li class="py-3 font-sans text-body-sm text-slate">{{ hideSends() ? 'No status changes yet.' : 'Nothing recorded yet.' }}</li>
        }
      </ol>
    </section>
  `,
})
export class ApplicationTimelineTab {
  readonly detail = input.required<DoctorApplicationDetailDto>();

  protected readonly hideSends = signal(false);

  protected readonly events = computed(() => {
    const list = [...(this.detail().events ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
    return this.hideSends() ? list.filter((e) => !isNotificationEvent(e.kind)) : list;
  });

  /** "Email sent" / "SMS sent" / "Notification failed (SMS)"; otherwise the API's label. */
  protected title(e: DoctorApplicationEventDto): string {
    const channel = e.channel ? CHANNEL[e.channel] ?? e.channel : '';
    if (e.kind === 'email_sent') return 'Email sent';
    if (e.kind === 'sms_sent') return 'SMS sent';
    if (e.kind === 'notification_failed') return channel ? `Notification failed (${channel})` : 'Notification failed';
    if (e.label) return e.label;
    return e.to_status ? applicationStatusBadge(e.to_status).label : e.kind.replace(/_/g, ' ');
  }

  protected icon(e: DoctorApplicationEventDto): string {
    if (e.kind === 'notification_failed') return 'circle-alert';
    return eventIcon(e.kind);
  }

  protected tone(e: DoctorApplicationEventDto): string {
    if (e.kind === 'notification_failed') return 'bg-alert/10 text-alert-ink';
    if (isNotificationEvent(e.kind)) return 'bg-glacier text-slate';
    return e.to_status ? applicationStatusBadge(e.to_status).cls : 'bg-frost text-cerulean-dark';
  }

  protected actor(e: DoctorApplicationEventDto): string {
    if (e.actor_name) return e.actor_name;
    if (e.actor_type === 'applicant') return 'Applicant';
    if (e.actor_type === 'staff') return 'Staff';
    return 'System';
  }

  protected when(iso: string): string {
    return dateTime(iso);
  }
}
