import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { IconComponent } from '@supadoc/ui';

/**
 * Reusable "coming soon" placeholder for dashboard sections that aren't built
 * yet. Title, icon and blurb come from the route's `data`, so a single
 * component backs every nav destination. Each nav item is a distinct route
 * config, so Angular recreates this with the correct snapshot on navigation.
 */
@Component({
  selector: 'pat-dashboard-placeholder',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div
      class="flex min-h-[60vh] flex-col items-center justify-center gap-5 py-16 text-center"
    >
      <span
        class="flex size-16 items-center justify-center rounded-full bg-frost/60 text-cerulean"
      >
        <sd-icon [name]="icon" [size]="30" />
      </span>
      <div class="flex max-w-md flex-col gap-2">
        <h1 class="font-heading text-h3 text-ink">{{ title }}</h1>
        <p class="font-sans text-body text-slate">{{ description }}</p>
      </div>
      <span
        class="rounded-pill bg-frost/60 px-4 py-1.5 font-sans text-caption font-medium text-cerulean"
      >
        Coming soon
      </span>
    </div>
  `,
})
export class DashboardPlaceholder {
  private readonly route = inject(ActivatedRoute);

  protected readonly title =
    (this.route.snapshot.data['title'] as string | undefined) ?? 'Coming soon';
  protected readonly icon =
    (this.route.snapshot.data['icon'] as string | undefined) ??
    'layout-dashboard';
  protected readonly description =
    (this.route.snapshot.data['description'] as string | undefined) ??
    'This section is coming soon.';
}
