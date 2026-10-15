import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  OnDestroy,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { IconComponent } from '@supadoc/ui';

let nextId = 0;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

const WIDTH: Record<'sm' | 'md' | 'lg' | 'xl', string> = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-5xl',
};

/**
 * A modal dialog for the back office (WAI-ARIA dialog pattern): a labelled
 * `role="dialog"` panel over a scrim; on open, focus moves to the first
 * `[data-autofocus]` element, else the first field, else the panel; Tab stays
 * inside; Esc, the scrim and × close it (not while `busy`); on close focus goes
 * back to whatever opened it (unless something else already took it). A
 * bottom sheet on phones, centred from `sm`.
 *
 * When the body swaps to another step (form → result), the focused button is
 * destroyed: call `refocus()` to put focus on the new step's `[data-autofocus]`
 * control. Until then Tab and Esc still work from wherever focus fell.
 *
 * Usage: `<bo-dialog [open]="ask()" title="Suspend Dr X" (closed)="ask.set(false)">
 *   …body… <div dialogFooter>…buttons…</div></bo-dialog>`
 */
@Component({
  selector: 'bo-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { '(document:keydown)': 'onDocKeydown($event)' },
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
        <div class="absolute inset-0 bg-abyss/40" aria-hidden="true" (click)="dismiss()"></div>
        <div
          #panel
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          [attr.aria-labelledby]="titleId"
          [attr.aria-describedby]="subtitle() ? subtitleId : null"
          class="relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-[16px] bg-white shadow-[0_8px_40px_rgba(10,22,40,0.2)] focus:outline-none sm:rounded-[16px]"
          [class]="widthClass()"
          (keydown)="onKeydown($event)"
        >
          <div class="flex items-start justify-between gap-3 border-b border-cloud px-5 py-4 sm:px-6">
            <div class="flex min-w-0 flex-col gap-0.5">
              <h2 [id]="titleId" class="break-words font-heading text-h5 text-ink">{{ title() }}</h2>
              @if (subtitle()) {
                <p [id]="subtitleId" class="font-sans text-body-sm text-slate">{{ subtitle() }}</p>
              }
            </div>
            <button
              type="button"
              class="-mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-slate transition-colors hover:bg-glacier hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:opacity-50"
              aria-label="Close"
              [disabled]="busy()"
              (click)="dismiss()"
            >
              <sd-icon name="x" [size]="22" />
            </button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            <ng-content />
          </div>
          <ng-content select="[dialogFooter]" />
        </div>
      </div>
    }
  `,
})
export class BoDialog implements OnDestroy {
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  readonly open = input(false);
  readonly title = input.required<string>();
  readonly subtitle = input('');
  readonly size = input<'sm' | 'md' | 'lg' | 'xl'>('md');
  /** While true (a request is in flight) Esc, the scrim and × do nothing. */
  readonly busy = input(false);
  readonly closed = output<void>();

  protected readonly titleId = `bo-dialog-${++nextId}-title`;
  protected readonly subtitleId = `${this.titleId}-sub`;
  protected readonly widthClass = computed(() => WIDTH[this.size()]);

  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private returnTo: HTMLElement | null = null;
  private wasOpen = false;

  constructor() {
    effect(() => {
      const isOpen = this.open();
      untracked(() => {
        if (isOpen && !this.wasOpen) {
          const active = this.doc.activeElement;
          this.returnTo = active instanceof HTMLElement ? active : null;
          afterNextRender(() => this.focusInitial(), { injector: this.injector });
        } else if (!isOpen && this.wasOpen) {
          this.restoreFocus();
        }
        this.wasOpen = isOpen;
      });
    });
  }

  ngOnDestroy(): void {
    if (this.wasOpen) this.restoreFocus();
  }

  protected dismiss(): void {
    if (!this.busy()) this.closed.emit();
  }

  /**
   * After the body changed step: focus the new `[data-autofocus]` control (else
   * the first field, else the panel) once it has rendered — unless the user is
   * already on a control inside the dialog.
   */
  refocus(): void {
    afterNextRender(
      () => {
        const panel = this.panel()?.nativeElement;
        const active = this.doc.activeElement;
        if (panel && (!active || active === panel || !panel.contains(active))) this.focusInitial();
      },
      { injector: this.injector },
    );
  }

  /**
   * Keys pressed while focus is outside the panel — it fell to the page body
   * when the control that had it was removed. Esc still closes, and Tab comes
   * back into the dialog instead of wandering the page behind it.
   */
  protected onDocKeydown(event: KeyboardEvent): void {
    if (!this.open()) return;
    const panel = this.panel()?.nativeElement;
    const active = this.doc.activeElement;
    if (!panel || (active && panel.contains(active))) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.dismiss();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const items = this.focusables(panel);
      (items.length === 0 ? panel : event.shiftKey ? items[items.length - 1] : items[0]).focus();
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = this.panel()?.nativeElement;
    if (!panel) return;
    const items = this.focusables(panel);
    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = this.doc.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private focusInitial(): void {
    const panel = this.panel()?.nativeElement;
    if (!panel) return;
    const wanted =
      panel.querySelector<HTMLElement>('[data-autofocus]') ??
      panel.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])');
    (wanted ?? panel).focus();
  }

  private focusables(panel: HTMLElement): HTMLElement[] {
    return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !el.hasAttribute('inert') && el.getClientRects().length > 0,
    );
  }

  /**
   * Back to the opener — only when focus was lost with the dialog: the closing
   * action may have sent it somewhere on purpose (e.g. "Go to Credentials").
   */
  private restoreFocus(): void {
    const target = this.returnTo;
    this.returnTo = null;
    if (!target) return;
    setTimeout(() => {
      const active = this.doc.activeElement;
      if (target.isConnected && (!active || active === this.doc.body)) target.focus();
    });
  }
}
