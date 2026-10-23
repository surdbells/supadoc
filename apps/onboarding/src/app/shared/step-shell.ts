import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent, LogoComponent, SmoothHeightDirective } from '@supadoc/ui';
import { Announcer } from '../core/announcer';
import { STEP_COUNT } from '../core/wizard-steps';

export type StepShellWidth = 'form' | 'choice';
export type StepHeaderAction = 'back' | 'check-status' | 'none';

/**
 * The application card (Figma "Doctor's Application" frames): 864px wide for
 * forms, 789px for the licence choice; radius 24, Haze hairline, blue glow;
 * padding 40/32 (20/24 below 900px). Header: the logo (→ home), "Step n of 7"
 * and Back / Check status. The `h1` takes focus after navigation and the step
 * is announced.
 *
 * Slots: `[stepBadge]` above the heading, `[stepIntro]` under the subtitle, the
 * default content, `[stepFooter]` at the bottom of the card, `[afterCard]` below it.
 */
@Component({
  selector: 'onb-step-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, LogoComponent, SmoothHeightDirective],
  host: { '[class]': 'hostClass()' },
  template: `
    <div [class]="cardClass()" [attr.role]="bare() ? null : 'main'">
      @if (!bare()) {
      <header
        class="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 min-[900px]:flex min-[900px]:h-12 min-[900px]:justify-between"
      >
        <a
          routerLink="/"
          aria-label="VideoMed, home"
          class="order-1 inline-flex w-fit rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
        >
          <sd-logo [size]="48" />
        </a>
        @if (step() !== null) {
          <p class="order-3 font-sans text-caption text-cerulean min-[900px]:order-2 min-[900px]:text-body">
            Step {{ step() }} of {{ total }}
          </p>
        }
        @switch (headerAction()) {
          @case ('back') {
            <button
              type="button"
              class="order-2 -mr-2 inline-flex h-10 items-center gap-2 rounded-lg px-2 font-sans text-body text-ink transition-colors hover:text-cerulean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 min-[900px]:order-3"
              (click)="back.emit()"
            >
              <sd-icon name="arrow-left" [size]="24" [strokeWidth]="1.5" />
              Back
            </button>
          }
          @case ('check-status') {
            <a
              routerLink="/"
              [queryParams]="{ dialog: 'track' }"
              class="order-2 -mr-2 inline-flex h-10 items-center rounded-lg px-2 font-sans text-body text-cerulean transition-colors hover:text-cerulean-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 min-[900px]:order-3"
            >
              Check status
            </a>
          }
        }
      </header>

      <div [class]="titleClass()">
        <ng-content select="[stepBadge]" />
        <h1 #headingEl tabindex="-1" class="font-sans text-h4 text-ink focus:outline-none">{{ heading() }}</h1>
        @if (subtitle()) {
          <!-- prettier-ignore -->
          <p [class]="subtitleClass()">@for (part of subtitleParts(); track $index) {@if ($index > 0) {<span class="text-alert">*</span>}{{ part }}}</p>
        }
        <ng-content select="[stepIntro]" />
      </div>
      }

      <!-- The card eases to its new height when errors or uploads change the content. -->
      <div sdSmoothHeight>
        <div class="flow-root"><ng-content /></div>
      </div>
      <ng-content select="[stepFooter]" />
    </div>
    <ng-content select="[afterCard]" />
  `,
})
export class StepShellComponent {
  private readonly announcer = inject(Announcer);

  readonly width = input<StepShellWidth>('form');
  /** "Step n of 7", or null (licence choice, review, submitted, status). */
  readonly step = input<number | null>(null);
  readonly heading = input.required<string>();
  /** A `*` in it is drawn in Alert red. */
  readonly subtitle = input<string>('');
  readonly headerAction = input<StepHeaderAction>('back');
  /** Centred title block (the licence choice and the submitted page). */
  readonly centred = input(false);
  /** Spoken on arrival; defaults to the heading (with "Step n of 7: " on steps). */
  readonly announcement = input<string | null>(null);
  readonly back = output<void>();
  /** Info mode (inside the respond page): no page, card, header or title, just the content. */
  readonly bare = input(false);
  /**
   * Title spacing: 'form' (40px under the header, subtitle 8px under the title)
   * or 'status' (Figma App 24: about 60px under the header, subtitle 16px under).
   */
  readonly titleSpacing = input<'form' | 'status'>('form');

  protected readonly total = STEP_COUNT;
  private readonly headingEl = viewChild<ElementRef<HTMLElement>>('headingEl');

  protected readonly hostClass = computed(() =>
    this.bare()
      ? 'block'
      : 'flex min-h-dvh w-full flex-col items-center justify-start bg-snow px-4 py-6 min-[900px]:justify-center min-[900px]:px-8 min-[900px]:py-10',
  );
  protected readonly cardClass = computed(
    () =>
      this.bare() ? '' :
      'w-full rounded-[24px] border border-haze bg-white px-5 py-6 shadow-[0_4px_16px_rgba(21,101,192,0.2)] ' +
      'min-[900px]:px-8 min-[900px]:py-10 ' +
      (this.width() === 'choice' ? 'max-w-[789px]' : 'max-w-[864px]'),
  );
  private readonly status = computed(() => this.titleSpacing() === 'status');
  protected readonly titleClass = computed(() => {
    const gap = this.status() ? 'mt-8 min-[900px]:mt-[60px]' : 'mt-8 min-[900px]:mt-10';
    return this.centred() ? `${gap} text-center` : gap;
  });
  protected readonly subtitleClass = computed(() =>
    this.centred()
      ? 'mx-auto mt-4 max-w-[552px] font-sans text-body-sm text-slate'
      : `${this.status() ? 'mt-4' : 'mt-2'} font-sans text-body-sm text-slate`,
  );
  protected readonly subtitleParts = computed(() => this.subtitle().split('*'));

  constructor() {
    afterNextRender(() => {
      const heading = this.headingEl()?.nativeElement;
      if (this.bare() || !heading) return;
      heading.focus({ preventScroll: true });
      const step = this.step();
      this.announcer.announce(
        this.announcement() ?? (step !== null ? `Step ${step} of ${this.total}: ${this.heading()}` : this.heading()),
      );
    });
  }

  /** Focus the heading again (e.g. after the content changed in place). */
  focusHeading(): void {
    this.headingEl()?.nativeElement.focus({ preventScroll: true });
  }
}
