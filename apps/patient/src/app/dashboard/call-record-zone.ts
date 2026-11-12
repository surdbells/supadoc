import { ChangeDetectionStrategy, Component, input, ViewEncapsulation } from '@angular/core';
import { ManageSharing } from './manage-sharing';
import { MyProfile } from './my-profile';

/*
 * The call workspace's own-record tabs, loaded only when the record is first
 * opened (a dynamic import on the call page, shown with CallRecordOutlet in
 * call-record-outlet.ts; not `@defer` or NgComponentOutlet, whose code would
 * join the initial bundle): the patient's Medical Information (read-only)
 * and Manage sharing, the portal's own components, embedded so that nothing in
 * them navigates. They sit on a paper zone that follows the PORTAL's theme
 * (they are portal pages), not the cockpit's tone:
 *  - `sd-rx-zone` gives the portal's light pill colours (tailwind/pills.css);
 *  - with the portal dark, the cockpit's guards (apps/patient/src/styles.css:
 *    `.sd-call .bg-white` / `.text-ink` kept light, a light cockpit's bright
 *    brand text kept at its light values) are undone here, and the pills take
 *    the portal's dark list again, so the zone reads as the dark portal does;
 *  - in a light cockpit, theme.css turns `text-white` into ink: filled controls
 *    in the zone (e.g. a life-threatening allergy chip) keep white text.
 * `[data-theme]` on `.sd-call` lifts these above the guards they undo.
 */
const ZONE_CSS = `
html[data-theme='dark'] .sd-call[data-theme] .pat-call-zone {
  color: #e5edf4;
  --sd-pill-fg: #94a6b5; --sd-pill-fg-hover: #e5edf4; --sd-pill-action-fg: #e5edf4;
  --sd-pill-hover-bg: rgb(255 255 255 / 0.06); --sd-pill-rest-bg: #161f2b; --sd-pill-rest-ring: #263445;
  --sd-pill-hover-ring: rgb(140 188 255 / 0.5); --sd-pill-on-bg: rgb(33 111 209 / 0.26); --sd-pill-on-fg: #8cbcff;
  --sd-pill-on-ring: #8cbcff; --sd-pill-focus: #8cbcff; --sd-track-bg: #111a24; --sd-track-line: #263445;
  --sd-count-off-bg: #212c39; --sd-count-off-fg: #94a6b5; --sd-tone-neutral-bg: #212c39; --sd-tone-neutral-fg: #94a6b5;
  --sd-tone-info-bg: rgb(33 111 209 / 0.26); --sd-tone-info-fg: #8cbcff; --sd-tone-success-fg: #81c784;
  --sd-tone-warning-fg: #f2a900; --sd-tone-danger-bg: rgb(229 57 53 / 0.15); --sd-tone-danger-fg: #ff8a80;
  --sd-tone-teal-bg: rgb(0 121 108 / 0.15); --sd-tone-teal-fg: #4db6ac;
}
html[data-theme='dark'] .sd-call[data-theme] .pat-call-zone .bg-white { background-color: #161f2b; }
html[data-theme='dark'] .sd-call[data-theme] .pat-call-zone .text-ink { color: #e5edf4; }
html[data-theme='dark'] .sd-call[data-theme] .pat-call-zone .text-alert { color: #ff8a80; }
html[data-theme='dark'] .sd-call[data-theme] .pat-call-zone .text-cerulean { color: #8cbcff; }
html[data-theme='dark'] .sd-call[data-theme] .pat-call-zone .text-sage { color: #81c784; }
html[data-theme='dark'] .sd-call[data-theme] .pat-call-zone .text-sky { color: #6cc0ff; }
html[data-theme='dark'] .sd-call[data-theme] .pat-call-zone .text-success { color: #6fdc8c; }
html[data-theme='dark'] .sd-call[data-theme] .pat-call-zone .text-teal { color: #4db6ac; }
.sd-call[data-theme] .pat-call-zone .text-white { color: #fff; }
`;

/** One of the two tabs: `record` (Medical Information, read-only) or `sharing` (Manage sharing). */
@Component({
  selector: 'pat-call-record-zone',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The rules reach into the embedded portal components; every selector is under `.pat-call-zone`.
  encapsulation: ViewEncapsulation.None,
  styles: [ZONE_CSS],
  imports: [ManageSharing, MyProfile],
  host: { class: 'block' },
  template: `
    <div class="pat-call-zone sd-rx-zone rounded-card bg-glacier p-3 text-ink sm:p-4">
      @if (kind() === 'record') {
        <pat-my-profile [embedded]="true" />
      } @else {
        <pat-manage-sharing [embedded]="true" />
      }
    </div>
  `,
})
export class CallRecordZone {
  readonly kind = input.required<'record' | 'sharing'>();
}
