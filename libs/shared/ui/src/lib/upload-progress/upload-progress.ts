import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { uploadFinishingText, uploadProgressText, type UploadProgress } from '@supadoc/data-access';

/**
 * One upload's progress bar. While the file goes up it fills with the real
 * share sent (`aria-valuenow`); once every byte is out but the server hasn't
 * answered yet — it is storing the file, sending notices — it turns into an
 * indeterminate sweep, "Finishing…", so it never sits frozen at 100%. A size
 * the browser can't tell (no total) sweeps too ("Uploading…") instead of
 * sitting at 0%. Reduced motion: a still, dimmed full bar instead of the sweep.
 *
 * With `announce` (the default) it tells screen readers, politely, when the
 * file is sent and finishing; a page with its own live region for the upload
 * passes `[announce]="false"` and says it there (`uploadFinishingText`).
 *
 * Feed it `uploadProgressFrom(event)` (from `@supadoc/data-access`), which
 * needs `withXhr()` in the app's `provideHttpClient(...)`.
 *
 * `<sd-upload-progress [progress]="p" label="Uploading scan.pdf" subject="scan.pdf" />`
 */
@Component({
  selector: 'sd-upload-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  styles: `
    @keyframes sd-upload-sweep {
      from {
        transform: translateX(-100%);
      }
      to {
        transform: translateX(250%);
      }
    }
    .sd-upload-sweep {
      width: 40%;
      animation: sd-upload-sweep 1.2s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .sd-upload-sweep {
        width: 100%;
        animation: none;
        opacity: 0.55;
      }
    }
  `,
  template: `
    <div
      class="relative w-full overflow-hidden rounded-full"
      [class]="trackClasses()"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      [attr.aria-valuenow]="determinate() ? progress().percent : null"
      [attr.aria-valuetext]="valueText()"
      [attr.aria-label]="label()"
      [attr.data-state]="state()"
    >
      @if (determinate()) {
        <div
          class="h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none"
          [class]="barClass()"
          [style.width.%]="progress().percent"
        ></div>
      } @else {
        <div class="sd-upload-sweep absolute inset-y-0 left-0 rounded-full" [class]="barClass()"></div>
      }
    </div>
    @if (announce()) {
      <span class="sr-only" aria-live="polite" aria-atomic="true">{{ announcement() }}</span>
    }
  `,
})
export class UploadProgressComponent {
  readonly progress = input.required<UploadProgress>();
  /** The bar's accessible name, e.g. "Uploading scan.pdf". */
  readonly label = input.required<string>();
  /** What is being sent, for the announcement: a file name, "Photo", "Your result". */
  readonly subject = input('');
  /** False: the page announces the upload in its own live region. */
  readonly announce = input(true);
  /** `sm` 6px (lists, fields), `md` 8px. */
  readonly size = input<'sm' | 'md'>('sm');
  /** The track's colour (a page theme can pass its own). */
  readonly trackClass = input('bg-frost');
  /** The fill's colour. */
  readonly barClass = input('bg-cerulean');

  /** A real share to show: known size, not yet finishing. */
  protected readonly determinate = computed(() => !this.progress().finishing && this.progress().percent !== null);
  protected readonly state = computed(() =>
    this.progress().finishing ? 'finishing' : this.determinate() ? 'uploading' : 'unknown',
  );
  protected readonly valueText = computed(() => uploadProgressText(this.progress()));
  protected readonly announcement = computed(() =>
    this.progress().finishing ? uploadFinishingText(this.subject()) : '',
  );
  protected readonly trackClasses = computed(
    () => `${this.size() === 'md' ? 'h-2' : 'h-1.5'} ${this.trackClass()}`,
  );
}
