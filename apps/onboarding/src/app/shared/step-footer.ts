import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { IconComponent } from '@supadoc/ui';
import { ONB_TEXT_BUTTON, ONB_WIDTH, onbButton } from './ui-classes';

/**
 * The step card's footer (Figma): "Save & continue later" (ghost, 200×48) on
 * the left; "Cancel application" (Alert outline, 200×48) and the primary
 * button (200 or 250 wide, `arrow-right`) on the right. Below 900px they stack:
 * primary (full width), Cancel, Save.
 *
 * The primary button keeps the Figma's disabled look while the step is
 * incomplete (`invalidLook`) but stays focusable and clickable (D29): the
 * page answers the click by showing what is missing.
 */
@Component({
  selector: 'onb-step-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div
      class="mt-10 flex flex-col gap-3 min-[900px]:mt-20 min-[900px]:flex-row min-[900px]:items-center min-[900px]:justify-between"
    >
      @if (showSave()) {
        <button
          type="button"
          [class]="saveClass"
          [disabled]="busy()"
          (click)="save.emit()"
        >
          Save &amp; continue later
        </button>
      } @else {
        <span class="hidden min-[900px]:block" aria-hidden="true"></span>
      }
      <div
        class="order-1 flex flex-col-reverse gap-3 min-[900px]:order-2 min-[900px]:flex-row min-[900px]:gap-6"
      >
        @if (showCancel()) {
          <button
            type="button"
            [class]="cancelClass"
            [disabled]="busy()"
            (click)="cancelApplication.emit()"
          >
            Cancel application
          </button>
        }
        <button
          type="button"
          [class]="primaryClass()"
          [attr.aria-disabled]="invalidLook() || null"
          [attr.aria-busy]="busy() || null"
          (click)="onPrimary()"
        >
          @if (busy()) {
            <sd-icon name="loader-circle" [size]="20" class="animate-spin" />
          }
          {{ primaryLabel() }}
          @if (arrow()) {
            <sd-icon name="arrow-right" [size]="24" [strokeWidth]="1.5" />
          }
        </button>
      </div>
    </div>
  `,
})
export class StepFooterComponent {
  readonly primaryLabel = input('Continue');
  /** Figma width of the primary button on desktop: 200, 250, 311 or 323. */
  readonly primaryWidth = input<200 | 250 | 311 | 323>(200);
  /** The step is not complete yet: Cerulean/30 look, `aria-disabled`, still clickable. */
  readonly invalidLook = input(false);
  readonly busy = input(false);
  readonly showSave = input(true);
  readonly showCancel = input(true);
  readonly arrow = input(true);

  readonly primary = output<void>();
  readonly save = output<void>();
  readonly cancelApplication = output<void>();

  protected readonly saveClass = `${ONB_TEXT_BUTTON} order-3 h-12 w-full justify-center text-body-sm disabled:opacity-60 min-[900px]:order-1 min-[900px]:w-[200px]`;
  protected readonly cancelClass = `${onbButton('outlineAlert')} w-full disabled:opacity-60 min-[900px]:w-[200px]`;
  protected readonly primaryClass = computed(
    () => `${onbButton('primary', this.invalidLook())} ${ONB_WIDTH[this.primaryWidth()]}`,
  );

  protected onPrimary(): void {
    if (this.busy()) return;
    this.primary.emit();
  }
}
