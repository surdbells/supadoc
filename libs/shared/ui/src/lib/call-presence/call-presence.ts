import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { CallPresenceDto } from '@supadoc/models';

/**
 * A pulsing "in the call" indicator for appointment lists and pages. Shows
 * nothing until someone is in the call; the wording is from the viewer's side
 * (`viewer`): "Doctor is in the call" / "Patient is waiting" when the other
 * person is there (green), "You're in the call" when it is only the viewer
 * (e.g. on another device), "In the call now" when both are.
 *
 * Usage: `<sd-call-presence [presence]="presence()[a.id]" viewer="patient" />`.
 */
@Component({
  selector: 'sd-call-presence',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @if (label(); as l) {
      <span
        class="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-pill font-sans font-semibold"
        [class]="pillClass()"
        [attr.title]="l"
      >
        <span class="relative flex size-2 shrink-0" aria-hidden="true">
          <span class="absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:animate-none" [class]="dotClass()"></span>
          <span class="relative inline-flex size-2 rounded-full" [class]="dotClass()"></span>
        </span>
        <span class="truncate">{{ l }}</span>
      </span>
    }
  `,
})
export class CallPresenceComponent {
  readonly presence = input<CallPresenceDto | null | undefined>(null);
  readonly viewer = input.required<'patient' | 'doctor'>();
  readonly size = input<'sm' | 'md'>('sm');

  /** The other person is in the call (what the viewer cares about most). */
  private readonly otherIn = computed(() => {
    const p = this.presence();
    if (!p) return false;
    return this.viewer() === 'patient' ? p.doctor : p.patient;
  });
  private readonly selfIn = computed(() => {
    const p = this.presence();
    if (!p) return false;
    return this.viewer() === 'patient' ? p.patient : p.doctor;
  });

  protected readonly label = computed(() => {
    const other = this.otherIn();
    const self = this.selfIn();
    if (other && self) return 'In the call now';
    if (other) return this.viewer() === 'patient' ? 'Doctor is in the call' : 'Patient is waiting';
    if (self) return "You're in the call";
    return '';
  });

  protected readonly pillClass = computed(() => {
    const tone = this.otherIn() ? 'bg-success/10 text-success' : 'bg-frost text-cerulean';
    const size = this.size() === 'md' ? 'px-3 py-1 text-body-sm' : 'px-2.5 py-0.5 text-caption';
    return `${tone} ${size}`;
  });

  protected readonly dotClass = computed(() => (this.otherIn() ? 'bg-success' : 'bg-cerulean'));
}
