import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, output } from '@angular/core';

/**
 * A labelled form field (Figma "Input Component"): the label (14px Ink, a
 * raised Alert `*`, Slate " (Optional)"), 4px gap, the projected control, then
 * the helper (Poppins 12, Slate) or the error (Alert, `role="alert"`).
 *
 * The parent passes `error` only once it should show (after blur or a
 * Continue click) and points the control at `describedBy()`:
 * `<onb-field #f forId="city" (left)="form.touch('city')" …><input id="city" [attr.aria-describedby]="f.describedBy()" …></onb-field>`.
 * `left` fires when focus leaves the whole field, not when it moves inside it
 * (into a dropdown's search box, the phone country list or the languages panel).
 */
@Component({
  selector: 'onb-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col', '(focusout)': 'onFocusOut($event)' },
  template: `
    @if (label()) {
      <!-- prettier-ignore -->
      <label [for]="forId()" class="font-sans text-body-sm text-ink">{{ label() }}@if (optional()) {<span class="text-slate"> (Optional)</span>}@if (required()) {<span class="ml-1 inline-block -translate-y-0.5 text-alert" aria-hidden="true">*</span><span class="sr-only"> (required)</span>}</label>
    }
    <div class="mt-1">
      <ng-content />
    </div>
    @if (error()) {
      <p [id]="errorId()" role="alert" class="mt-1 font-label text-caption text-alert">{{ error() }}</p>
    } @else if (hint()) {
      <p [id]="hintId()" class="mt-1 font-label text-caption text-slate">{{ hint() }}</p>
    }
  `,
})
export class FieldComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly label = input('');
  /** Id of the control the label is for (also the base of the hint / error ids). */
  readonly forId = input.required<string>();
  readonly required = input(false);
  readonly optional = input(false);
  readonly hint = input<string | null>(null);
  /** Shown instead of the hint, as an alert. */
  readonly error = input<string | null | undefined>(null);
  /** Focus left the field (the "validate on blur" moment, §6.7). */
  readonly left = output<void>();

  readonly hintId = computed(() => `${this.forId()}-hint`);
  readonly errorId = computed(() => `${this.forId()}-error`);
  /** What the control's `aria-describedby` should be. */
  readonly describedBy = computed(() => (this.error() ? this.errorId() : this.hint() ? this.hintId() : null));

  protected onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && this.host.nativeElement.contains(next)) return;
    this.left.emit();
  }
}
