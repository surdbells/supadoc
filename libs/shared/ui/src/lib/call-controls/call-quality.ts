import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** How a connection reads: bars lit (null while checking), the word, and the bar colour. */
export interface CallQualityInfo {
  readonly bars: 0 | 1 | 2 | 3 | null;
  readonly word: 'Good' | 'Fair' | 'Poor' | 'Offline' | 'Checking…';
  readonly tone: 'bg-success' | 'bg-warning' | 'bg-alert' | null;
}

/**
 * Agora's network quality (0 unknown, 1 excellent … 5 very bad, 6 down) as
 * shown: 1–2 Good (3 bars), 3 Fair (2), 4–5 Poor (1), 6 Offline (0), and
 * Checking… for 0, null or anything else. Pass the worse of uplink and
 * downlink.
 */
export function callQualityInfo(quality: number | null | undefined): CallQualityInfo {
  switch (quality) {
    case 1:
    case 2:
      return { bars: 3, word: 'Good', tone: 'bg-success' };
    case 3:
      return { bars: 2, word: 'Fair', tone: 'bg-warning' };
    case 4:
    case 5:
      return { bars: 1, word: 'Poor', tone: 'bg-alert' };
    case 6:
      return { bars: 0, word: 'Offline', tone: 'bg-alert' };
    default:
      return { bars: null, word: 'Checking…', tone: null };
  }
}

/**
 * Real connection quality for the call's top bar (never a static "signal"
 * graphic): three bars and, from `sm` up, the word. One `role="img"` named
 * "Connection: Good" — the bars and word are not read separately.
 */
@Component({
  selector: 'sd-call-quality',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0' },
  template: `
    <span role="img" [attr.aria-label]="'Connection: ' + info().word" class="inline-flex items-center gap-1.5">
      <span class="flex h-3.5 items-end gap-0.5" aria-hidden="true">
        @for (h of heights; track h; let i = $index) {
          <span class="w-1 rounded-sm" [class]="h + ' ' + barClass(i)"></span>
        }
      </span>
      <span class="hidden font-sans text-caption text-white/80 sm:inline" aria-hidden="true">{{ info().word }}</span>
    </span>
  `,
})
export class CallQualityComponent {
  /** The worse of Agora's `uplinkNetworkQuality` / `downlinkNetworkQuality`; null before the first report. */
  readonly quality = input<number | null>(null);

  protected readonly info = computed(() => callQualityInfo(this.quality()));
  protected readonly heights = ['h-1.5', 'h-2.5', 'h-3.5'] as const;

  protected barClass(i: number): string {
    const { bars, tone } = this.info();
    return bars !== null && tone && i < bars ? tone : 'bg-white/25';
  }
}
