import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

export type CardPadding = 'none' | 'md' | 'lg';

/**
 * Surface container used to group content. `interactive` adds a premium
 * hover-lift for clickable cards. Usage: `<sd-card [interactive]="true">…</sd-card>`.
 */
@Component({
  selector: 'sd-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div [class]="classes()">
      <ng-content />
    </div>
  `,
})
export class CardComponent {
  /** Adds a hover-lift + shadow growth for clickable cards. */
  readonly interactive = input(false);
  readonly padding = input<CardPadding>('md');

  protected readonly classes = computed(() => {
    const pad = { none: '', md: 'p-6', lg: 'p-8' }[this.padding()];
    const base =
      `rounded-card bg-white ${pad} ` +
      'shadow-[0_1px_3px_rgba(10,22,40,0.06)] ring-1 ring-cloud/70';
    const interactive = this.interactive()
      ? ' cursor-pointer transition-all duration-200 ease-out ' +
        'hover:-translate-y-0.5 hover:shadow-[0_12px_30px_rgba(10,22,40,0.10)] hover:ring-cerulean/30'
      : '';
    return (base + interactive).trim();
  });
}
