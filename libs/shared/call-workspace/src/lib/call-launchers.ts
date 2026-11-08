import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IconComponent } from '@supadoc/ui';
import type { LauncherOpen, LauncherStatus, WorkspaceTabDef } from './workspace-types';

/*
 * The launcher list under a call's video: one button per workspace tool, each
 * opening the workspace on its tab. A card of its own (not a pill): the icon in
 * its tile, the label, and under it an optional status caption line.
 *
 * Alignment: the status line is rendered only when there is a status. When
 * there is none, its 18px stays reserved as padding on the text column, below
 * the label while the icon sits above, and 9px above and 9px below once the icon
 * sits beside the text. So a label alone is centred on its icon, a label with a
 * status is centred as one block, and a status appearing never changes a
 * launcher's height (or its row's).
 */

/*
 * Component styles (never new Tailwind utilities: those land in every app's
 * initial styles.css). The container is the host's content box: below 32rem two
 * columns, icon above; 32-51.99rem one row, icon above, caption labels; from
 * 52rem one row, icon beside, body-sm labels.
 */
export const LAUNCHER_CSS = `
:host { display: block; container: sd-launchers / inline-size; }
.ws-launchers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
.ws-launchers > li { min-width: 0; }
.ws-launchers > li:last-child:nth-child(odd) { grid-column: 1 / -1; }
.ws-launcher { display: flex; flex-direction: column; align-items: flex-start; gap: 0.25rem; width: 100%; height: 100%; padding: 0.5rem 0.75rem; text-align: left; }
/* theme.css has no light remap for frost: about 1.3:1 on the light cockpit. */
.ws-launcher:focus-visible { outline: 2px solid var(--color-frost); outline-offset: 2px; }
:host([data-tone='light']) .ws-launcher:focus-visible { outline-color: var(--color-cerulean); }
/* hover:bg-white/[0.08] has no light remap (white on white): glacier instead. */
@media (hover: hover) { :host([data-tone='light']) .ws-launcher:hover { background-color: var(--color-glacier); } }
.ws-launcher-text { display: flex; min-width: 0; flex-direction: column; }
/* No status: its caption line stays reserved, so a status appearing never changes the height. Icon above: below the label. */
.ws-launcher-text--bare { padding-bottom: var(--text-caption--line-height); }
.ws-launcher-label {
  font-size: var(--text-body-sm); line-height: var(--text-body-sm--line-height); letter-spacing: var(--text-body-sm--letter-spacing);
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: normal;
}
/* Exactly one caption line: the same 18px the bare padding reserves. */
.ws-launcher-status { display: flex; min-width: 0; align-items: center; gap: 0.25rem; height: var(--text-caption--line-height);
  font-size: var(--text-caption); line-height: var(--text-caption--line-height); letter-spacing: var(--text-caption--letter-spacing); }
.ws-launcher-status-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-launcher-status--warn { color: var(--color-warning); }
:host([data-tone='light']) .ws-launcher-status--warn { color: var(--color-warning-ink); }
.ws-launcher-status--new { color: var(--color-frost); }
:host([data-tone='light']) .ws-launcher-status--new { color: var(--color-cerulean); }
.ws-launcher-dot { flex: none; width: 0.375rem; height: 0.375rem; border-radius: 999px; }
/* The "new" dot takes the status colour; the live dot keeps its bg-alert. */
.ws-launcher-status--new .ws-launcher-dot { background: currentColor; }
/* 32-51.99rem: ONE ROW (as many columns as launchers), icon above, caption labels. */
@container sd-launchers (min-width: 32rem) {
  .ws-launchers { grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); }
  .ws-launchers > li:last-child:nth-child(odd) { grid-column: auto; }
  .ws-launcher { padding: 0.5rem 0.375rem; }
  .ws-launcher-label { font-size: var(--text-caption); line-height: var(--text-caption--line-height); letter-spacing: var(--text-caption--letter-spacing); }
}
/* From 52rem: icon beside the text, body-sm labels. The reserved line splits 9px above, 9px below the label,
   so a label alone is centred on the icon, and label + status are centred as one block. */
@container sd-launchers (min-width: 52rem) {
  .ws-launcher { flex-direction: row; align-items: center; gap: 0.5rem; padding: 0.625rem 0.75rem; }
  .ws-launcher-label { font-size: var(--text-body-sm); line-height: var(--text-body-sm--line-height); letter-spacing: var(--text-body-sm--letter-spacing); }
  .ws-launcher-text--bare { padding-block: calc(var(--text-caption--line-height) / 2); }
}
`;

/** The launcher list (see the file's comment). `K` is the call page's tab keys. */
@Component({
  selector: 'sd-call-launchers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { '[attr.data-tone]': 'tone()' },
  styles: [LAUNCHER_CSS],
  template: `
    <ul class="ws-launchers" role="list">
      @for (t of items(); track t.key) {
        @let s = statuses()[t.key];
        <li>
          <button
            type="button"
            class="ws-launcher rounded-2xl border border-white/10 bg-white/[0.04] transition-colors hover:bg-white/[0.08]"
            [attr.data-ws-launcher]="t.key"
            aria-haspopup="dialog"
            (click)="open(t.key, $event)"
          >
            <span class="flex size-8 shrink-0 items-center justify-center rounded-xl bg-cerulean/15 text-frost" aria-hidden="true"><sd-icon [name]="t.icon" [size]="18" /></span>
            <span class="ws-launcher-text" [class.ws-launcher-text--bare]="!s">
              <span class="ws-launcher-label font-sans font-semibold text-white">{{ t.label }}</span>
              @if (s) {
                <span class="ws-launcher-status font-sans" [class]="statusClass(s.tone)">
                  <span class="sr-only">, </span>
                  @if (s.tone === 'live') {
                    <span class="ws-launcher-dot bg-alert motion-safe:animate-pulse" aria-hidden="true"></span>
                  } @else if (s.tone === 'new') {
                    <span class="ws-launcher-dot" aria-hidden="true"></span>
                  }
                  <span class="ws-launcher-status-text">{{ s.text }}</span>
                  @if (s.sr) {
                    <span class="sr-only">{{ s.sr }}</span>
                  }
                </span>
              }
            </span>
          </button>
        </li>
      }
    </ul>
  `,
})
export class CallLaunchers<K extends string = string> {
  readonly items = input.required<readonly WorkspaceTabDef<K>[]>();
  /** What each launcher says under its label (none: its caption line stays reserved). */
  readonly statuses = input<Partial<Record<K, LauncherStatus>>>({});
  /** The cockpit's tone: the focus ring, the hover and the coloured statuses follow it. */
  readonly tone = input<'dark' | 'light'>('dark');
  readonly opened = output<LauncherOpen<K>>();

  protected statusClass(tone: LauncherStatus['tone']): string {
    return tone === 'warn' ? 'ws-launcher-status--warn' : tone === 'new' ? 'ws-launcher-status--new' : 'text-white/70';
  }

  protected open(key: K, e: Event): void {
    const b = e.currentTarget;
    if (b instanceof HTMLElement) this.opened.emit({ key, opener: b });
  }
}
