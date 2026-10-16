import { afterRenderEffect, Directive, ElementRef, inject, input } from '@angular/core';

/**
 * Accessibility glue for `<sd-search-select>`, which renders its trigger
 * button without a label of its own:
 *
 * - names the trigger after a visible label (`boSelectA11y="label-id"` →
 *   `aria-labelledby="label-id trigger-id"`, so it reads "Specialty,
 *   Cardiology"), marks it as opening a pop-up (a search box and a list of
 *   option buttons — not a `listbox`), and keeps `aria-expanded`;
 * - points it at a hint / error (`boSelectDescribedBy`);
 * - Enter in the menu's search box never submits the form around the field
 *   (implicit submission): it picks the first match instead, once something
 *   was typed;
 * - Esc while the menu is open closes just the menu (from an option too), not
 *   a dialog the field sits in;
 * - when the menu closes from inside (an option picked, Esc), puts focus back
 *   on the trigger instead of letting it fall to the page.
 *
 * Usage: `<span id="x-label">Specialty</span>
 *   <sd-search-select boSelectA11y="x-label" [boSelectDescribedBy]="err ? 'x-err' : null" … />`
 */
@Directive({
  selector: 'sd-search-select[boSelectA11y]',
  host: {
    '(click)': 'sync(true)',
    '(keydown.enter)': 'onEnter($event)',
    '(keydown.escape)': 'onEscape($event)',
  },
})
export class SearchSelectA11y {
  /** Id of the element that labels the field. */
  readonly boSelectA11y = input.required<string>();
  /** Space-separated ids of a hint and/or error, or null. */
  readonly boSelectDescribedBy = input<string | null>(null);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    afterRenderEffect(() => {
      const labelId = this.boSelectA11y();
      const describedBy = this.boSelectDescribedBy();
      const trigger = this.trigger();
      if (!trigger) return;
      if (!trigger.id) trigger.id = `${labelId}-trigger`;
      trigger.setAttribute('aria-labelledby', `${labelId} ${trigger.id}`);
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-expanded', String(this.isOpen()));
      if (describedBy) trigger.setAttribute('aria-describedby', describedBy);
      else trigger.removeAttribute('aria-describedby');
    });
  }

  /**
   * Enter in the menu's search box. That box is a text field inside the
   * host's `<form>`, where Enter would submit the form (saving or creating
   * with the old value while the menu is still open): stop that, and pick the
   * first match when the person typed something. Enter on the trigger or an
   * option is a button press and is left alone.
   */
  protected onEnter(event: Event): void {
    if (!(event.target instanceof HTMLInputElement) || !this.isOpen()) return;
    if ((event as KeyboardEvent).isComposing) return;
    event.preventDefault();
    if (event.target.value.trim() === '') return;
    this.firstOption()?.click();
  }

  /**
   * Esc inside the field. The menu is still in the DOM here (the component
   * re-renders after the event), so "open" means this Esc is the menu's: keep
   * it from the dialog around the field (sd-dialog ignores a handled Esc), and
   * close the menu when the component didn't (focus on an option).
   */
  protected onEscape(event: Event): void {
    if (this.isOpen()) {
      event.preventDefault();
      if (!(event.target instanceof HTMLInputElement)) {
        this.host.nativeElement.querySelector<HTMLButtonElement>('button[aria-hidden="true"]')?.click();
      }
    }
    this.sync(true);
  }

  /** After the component has reacted to a click / Esc: update `aria-expanded` and rescue focus. */
  protected sync(restoreFocus: boolean): void {
    setTimeout(() => {
      const trigger = this.trigger();
      if (!trigger) return;
      const open = this.isOpen();
      trigger.setAttribute('aria-expanded', String(open));
      if (!restoreFocus || open) return;
      const active = this.host.nativeElement.ownerDocument.activeElement;
      const lost = !active || active === this.host.nativeElement.ownerDocument.body || !active.isConnected;
      if (lost || this.host.nativeElement.contains(active)) trigger.focus();
    });
  }

  /** The trigger is the component's first button. */
  private trigger(): HTMLButtonElement | null {
    return this.host.nativeElement.querySelector('button');
  }

  /**
   * The first option the menu shows. Options carry their label in a `<span>`;
   * the "clear" row (when `clearable`) is bare text, so it is skipped.
   */
  private firstOption(): HTMLButtonElement | null {
    const buttons = this.host.nativeElement.querySelectorAll<HTMLButtonElement>('.sd-menu li > button');
    return Array.from(buttons).find((b) => b.firstElementChild?.tagName === 'SPAN') ?? null;
  }

  private isOpen(): boolean {
    return this.host.nativeElement.querySelector('.sd-menu') !== null;
  }
}
