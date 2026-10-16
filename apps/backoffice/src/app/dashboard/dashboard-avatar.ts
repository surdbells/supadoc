import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { SpecialistsApi } from '@supadoc/data-access';
import { initials } from './dashboard-ui';

/**
 * A doctor's photo (their uploaded `/uploads/…` path resolved against the API)
 * or their initials when there is none or it fails to load. Decorative: the
 * name is always written next to it.
 */
@Component({
  selector: 'bo-dash-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'shrink-0', 'aria-hidden': 'true' },
  template: `
    @if (src(); as s) {
      <img [src]="s" alt="" class="rounded-full border border-cloud object-cover" [style.width.px]="size()" [style.height.px]="size()" (error)="failed.set(s)" />
    } @else {
      <span class="flex items-center justify-center rounded-full bg-frost font-heading text-body-sm font-semibold text-cerulean-dark" [style.width.px]="size()" [style.height.px]="size()">{{ letters() }}</span>
    }
  `,
})
export class DashboardAvatar {
  private readonly specialists = inject(SpecialistsApi);

  readonly name = input.required<string>();
  readonly photo = input<string | null | undefined>(null);
  readonly size = input(40);

  protected readonly failed = signal<string | null>(null);
  protected readonly src = computed(() => {
    const s = this.specialists.assetUrl((this.photo() ?? '').trim() || null);
    return s && s !== this.failed() ? s : null;
  });
  protected readonly letters = computed(() => initials(this.name()) || '?');
}
