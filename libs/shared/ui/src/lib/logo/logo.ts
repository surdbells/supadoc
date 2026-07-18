import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * VideoMed brand logo — the app mark (a Cerulean rounded square with a white
 * medical cross) and optional "VideoMed" wordmark. The mark is an inline,
 * static SVG (no untrusted markup), so it is safe and crisp at any size.
 *
 * Usage: `<sd-logo [size]="40" />` or `<sd-logo [size]="32" [wordmark]="false" />`.
 */
@Component({
  selector: 'sd-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    style:
      'display:inline-flex;align-items:center;gap:8px;vertical-align:middle',
  },
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="VideoMed"
    >
      <rect width="48" height="48" rx="12" fill="#1565C0" />
      <path
        d="M24 13.5v21M13.5 24h21"
        stroke="#FCFCFC"
        stroke-width="5"
        stroke-linecap="round"
      />
    </svg>
    @if (wordmark()) {
      <span
        class="font-sans font-semibold leading-none tracking-[0.02em]"
        [style.fontSize.px]="size() * 0.5"
      >
        <span style="color:#1565C0">Video</span
        ><span style="color:#00897B">Med</span>
      </span>
    }
  `,
})
export class LogoComponent {
  /** Height/width of the square mark in px. Wordmark scales to half of this. */
  readonly size = input<number>(40);
  readonly wordmark = input<boolean>(true);
}
