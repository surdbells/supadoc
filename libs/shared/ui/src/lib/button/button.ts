import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

export type ButtonVariant =
  'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

// VideoMed button: 16px radius, SF Pro Semibold, Cerulean primary, Ash when disabled.
const BASE =
  'inline-flex items-center justify-center gap-2 rounded-field font-sans font-semibold ' +
  'tracking-[0.48px] transition-colors select-none focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:pointer-events-none disabled:bg-ash disabled:text-white/70';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-cerulean text-white hover:bg-cerulean-dark',
  secondary:
    'bg-white text-cerulean ring-1 ring-inset ring-frost hover:bg-glacier',
  // Transparent with a Cerulean hairline — the design's "View All" / "Complete Profile".
  outline:
    'bg-transparent text-cerulean ring-1 ring-inset ring-cerulean hover:bg-frost/30',
  ghost: 'bg-transparent text-cerulean hover:bg-frost/40',
  danger: 'bg-alert text-white hover:brightness-95',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3 py-2.5 text-[14px] leading-[22px]',
  md: 'px-4 py-3 text-[16px] leading-6',
  lg: 'px-5 py-3.5 text-[18px] leading-7',
};

/** Shared design-system button. Usage: `<sd-button variant="primary">Save</sd-button>`. */
@Component({
  selector: 'sd-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.block]': 'full()',
    '[class.inline-block]': '!full()',
  },
  template: `
    <button [type]="type()" [class]="classes()" [disabled]="disabled()">
      <ng-content />
    </button>
  `,
})
export class ButtonComponent {
  readonly variant = input<ButtonVariant>('primary');
  readonly size = input<ButtonSize>('md');
  readonly type = input<'button' | 'submit' | 'reset'>('button');
  readonly disabled = input<boolean>(false);
  /** Stretch to the full width of the container (as forms do in the design). */
  readonly full = input<boolean>(false);

  protected readonly classes = computed(() =>
    [
      BASE,
      VARIANTS[this.variant()],
      SIZES[this.size()],
      this.full() ? 'w-full' : '',
    ]
      .join(' ')
      .trim(),
  );
}
