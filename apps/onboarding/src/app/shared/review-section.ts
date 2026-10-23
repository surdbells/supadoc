import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IconComponent } from '@supadoc/ui';

export interface ReviewRow {
  readonly label: string;
  readonly value: string | null | undefined;
}

/**
 * A review card (Figma "ReviewSectionCard"): a Sage `circle-check-big`, the
 * section title, an optional projected `[sectionTag]` and Edit (pencil) on the
 * right, then label/value rows ("—" when empty). `editLabel` names the button
 * for screen readers.
 */
@Component({
  selector: 'onb-review-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <section class="rounded-card border border-haze bg-white px-4 pb-2 pt-4 shadow-card sm:px-6" [attr.aria-labelledby]="headingId()">
      <!-- [title …… tag  Edit]; at 375px the tag and Edit drop to a second line, right-aligned, rather than overflow. -->
      <div class="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1">
        <h2 [id]="headingId()" class="flex min-w-0 flex-1 items-center gap-2.5 font-sans text-body font-semibold text-ink">
          <sd-icon [name]="icon()" [size]="20" [strokeWidth]="1.5" [class]="'shrink-0 ' + iconClass()" />
          {{ title() }}
        </h2>
        <div class="ml-auto flex shrink-0 items-center gap-3">
          <ng-content select="[sectionTag]" />
          @if (showEdit()) {
            <button
              type="button"
              class="-mr-2 inline-flex h-10 items-center gap-2 rounded-lg px-2 font-sans text-body-sm text-cerulean hover:text-cerulean-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
              [attr.aria-label]="editLabel() || 'Edit ' + title()"
              [attr.aria-expanded]="expanded()"
              (click)="edit.emit()"
            >
              <sd-icon name="pencil" [size]="20" [strokeWidth]="1.5" />
              {{ editText() }}
            </button>
          }
        </div>
      </div>
      @if (rows().length) {
        <dl class="mt-2 border-t-[0.5px] border-ash">
          @for (row of rows(); track $index; let last = $last) {
            <div
              class="flex flex-col gap-0.5 py-2 sm:min-h-[38px] sm:flex-row sm:items-center sm:justify-between sm:gap-6"
              [class]="last ? '' : 'border-b-[0.5px] border-ash'"
            >
              <dt class="font-sans text-caption text-slate">{{ row.label }}</dt>
              <dd class="break-words font-sans text-body-sm text-ink sm:max-w-[60%] sm:text-right">{{ row.value || '—' }}</dd>
            </div>
          }
        </dl>
      }
      <ng-content />
    </section>
  `,
})
export class ReviewSectionComponent {
  readonly title = input.required<string>();
  readonly sectionId = input.required<string>();
  readonly rows = input<readonly ReviewRow[]>([]);
  readonly showEdit = input(true);
  readonly editText = input('Edit');
  readonly editLabel = input<string | null>(null);
  /** For an Edit that opens the form in place (respond page). */
  readonly expanded = input<boolean | null>(null);
  readonly icon = input('circle-check-big');
  readonly iconClass = input('text-sage');
  readonly edit = output<void>();

  protected headingId(): string {
    return `${this.sectionId()}-heading`;
  }
}
