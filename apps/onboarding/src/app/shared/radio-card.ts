import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

/**
 * A radio option drawn as a card: the licence choice (title, description,
 * icon, 24px radio, Haze fill when chosen) and the Track channel card
 * (`variant="channel"`: icon disc, no visible radio, Cerulean/10 fill when
 * chosen). A visually hidden native radio inside a label, so a `<fieldset>` of
 * them gets arrow keys and Space for free.
 *
 * The projected `[cardIcon]` has a single slot (placed by the grid), because
 * content can only be projected into one `<ng-content>`.
 */
@Component({
  selector: 'onb-radio-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <label [class]="cardClass()">
      <input
        type="radio"
        class="sr-only"
        [name]="name()"
        [value]="value()"
        [checked]="checked()"
        [attr.aria-describedby]="descriptionId()"
        (change)="picked.emit(value())"
      />
      <span [class]="iconClass()" aria-hidden="true"><ng-content select="[cardIcon]" /></span>
      <span [class]="titleClass()">{{ title() }}</span>
      <span [id]="descriptionId()" [class]="descriptionClass()">{{ description() }}</span>
      @if (variant() === 'choice') {
        <span [class]="radioClass()" aria-hidden="true">
          @if (checked()) {
            <span class="size-[15px] rounded-full bg-cerulean"></span>
          }
        </span>
      }
    </label>
  `,
})
export class RadioCardComponent {
  readonly name = input.required<string>();
  readonly value = input.required<string>();
  readonly checked = input(false);
  readonly title = input.required<string>();
  readonly description = input('');
  readonly variant = input<'choice' | 'channel'>('choice');
  readonly picked = output<string>();

  protected readonly descriptionId = computed(() => `${this.name()}-${this.value()}-desc`);
  private readonly channel = computed(() => this.variant() === 'channel');

  protected readonly cardClass = computed(() => {
    const focus = 'focus-within:ring-2 focus-within:ring-cerulean/40';
    if (this.channel()) {
      const state = this.checked() ? 'border-cerulean bg-cerulean/10' : 'border-haze bg-white hover:border-cerulean/40';
      return `grid min-h-[82px] cursor-pointer grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 rounded-field border py-4 pl-6 pr-4 transition-colors ${state} ${focus}`;
    }
    const state = this.checked()
      ? 'border-transparent bg-haze shadow-raised'
      : 'border-ash bg-white hover:border-cerulean/40';
    return `grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-2 rounded-field border p-6 transition-colors ${state} ${focus}`;
  });

  protected readonly iconClass = computed(() =>
    this.channel()
      ? `col-start-1 row-span-2 row-start-1 inline-flex size-9 items-center justify-center rounded-full text-cerulean ${this.checked() ? 'bg-white' : 'bg-cerulean/10'}`
      : 'col-start-1 row-start-1 inline-flex text-ink',
  );

  protected readonly titleClass = computed(() =>
    this.channel()
      ? 'col-start-2 row-start-1 self-end font-sans text-body font-semibold text-ink'
      : 'col-start-2 row-start-1 font-sans text-body-lg text-ink',
  );

  protected readonly descriptionClass = computed(() =>
    this.channel()
      ? 'col-start-2 row-start-2 self-start break-words font-sans text-[13px] leading-5 text-slate'
      : // Ink/80 (6.5:1 on Haze): Slate on the chosen card's Haze fill is only 4.32:1 (§6.8).
        `col-span-2 col-start-1 row-start-2 font-sans text-body-sm ${this.checked() ? 'text-ink/80' : 'text-slate'}`,
  );

  protected readonly radioClass = computed(
    () =>
      `col-start-3 row-span-2 row-start-1 ml-4 inline-flex size-6 shrink-0 items-center justify-center rounded-full border-2 ${this.checked() ? 'border-cerulean' : 'border-slate'}`,
  );
}
