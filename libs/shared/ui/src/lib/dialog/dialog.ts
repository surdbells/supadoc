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
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { IconComponent } from '../icon/icon';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';
export type DialogRole = 'dialog' | 'alertdialog';
export type DialogLayout = 'standard' | 'plain';

let nextId = 0;

/** Exit animation length (ms). */
const EXIT_MS = 160;
/** Class that runs the exit transition (the `<dialog>` is already closed natively). */
const LEAVING = 'sd-dialog--leaving';

/** Open dialogs, bottom → top. Only the top one answers Esc and the scrim. */
const openStack: DialogComponent[] = [];
/** Dialogs holding the page-scroll lock (any number may be open at once). */
let scrollLocks = 0;
let savedRootStyle: { overflow: string; scrollbarGutter: string } | null = null;

const FIELDS =
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])';
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

/**
 * The design-system modal: a native `<dialog>` opened with `showModal()`, so it
 * sits in the browser's top layer (no z-index fights with other overlays), the
 * page behind it is inert, and Tab cannot wander off into it.
 *
 * - **Labelled**: `aria-labelledby` → the title, `aria-describedby` → the
 *   subtitle (or the ids passed in `labelledBy` / `describedBy`, for the
 *   `plain` layout). `dialogRole="alertdialog"` for urgent prompts.
 * - **Focus**: on open, focus moves to the first `[data-autofocus]` element,
 *   else the first field, else the dialog itself. The moment `open` turns false
 *   the native dialog closes (the exit animation plays on a closed, inert copy
 *   kept in the top layer), so the page is interactive again at once and focus
 *   goes back to whatever opened the dialog. To send focus somewhere else after
 *   closing (e.g. "Go to Credentials"), move it from a `setTimeout` in the
 *   closing handler or in `(afterClose)` — not synchronously in the handler
 *   that sets `open` to false: the page behind is inert until the dialog has
 *   closed, and focusing it then does nothing.
 * - **Dismissal**: Esc, a click on the scrim and × emit `closed` — the parent
 *   then sets `open` to false. Nothing closes it while `busy`; with
 *   `dismissible` false nothing but the parent closes it (no ×).
 * - **Layout**: a bottom sheet on phones, centred from `sm`; the body scrolls,
 *   the `[dialogFooter]` stays put. The page behind does not scroll.
 * - **Motion**: fades/slides in and out unless the user prefers reduced motion
 *   (the exit only where the browser can transition `overlay`/`display`;
 *   elsewhere it closes instantly).
 * - **Title**: a static `title="…"` is only the heading — it is removed from
 *   the host element so the browser shows no tooltip over the dialog.
 * - **Theme**: colours are `--sd-dialog-*` custom properties (light by default,
 *   dark under the patient portal's `html[data-theme='dark']`); projected
 *   content may use them too, e.g. `text-(--sd-dialog-muted)`.
 *
 * When the body swaps to another step (form → result), the focused control is
 * destroyed: call `refocus()` to put focus on the new step's `[data-autofocus]`.
 *
 * Usage:
 * ```html
 * <sd-dialog [open]="editing()" title="Edit staff member" [busy]="saving()" (closed)="editing.set(false)">
 *   …body…
 *   <div dialogFooter class="flex justify-end gap-3 border-t border-cloud px-6 py-4">…buttons…</div>
 * </sd-dialog>
 * ```
 *
 * `bo-dialog` is a transitional alias of this component for the back office's
 * existing templates (`export { DialogComponent as BoDialog } from '@supadoc/ui'`).
 */
@Component({
  selector: 'sd-dialog, bo-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  // `title` is an input: drop the attribute a static `title="…"` leaves on the
  // host, or the browser shows it as a tooltip anywhere over the dialog.
  host: { '[attr.title]': 'null', '(document:keydown)': 'onDocKeydown($event)' },
  styles: `
    :host {
      display: contents;
    }

    .sd-dialog {
      --sd-dialog-surface: #ffffff;
      --sd-dialog-raised: #f4f8fb;
      --sd-dialog-hover: #f1f9ff;
      --sd-dialog-text: #1c2b3a;
      --sd-dialog-strong: #0a1628;
      --sd-dialog-muted: #546e7a;
      --sd-dialog-border: #eceff1;
      --sd-dialog-field: #b8c6d4;
      --sd-dialog-ring: rgb(11 98 228 / 0.4);
      --sd-dialog-shadow:
        0 0 0 1px rgb(209 233 253), 0 4px 4px rgb(21 101 192 / 0.1),
        0 16px 40px rgb(10 22 40 / 0.16);
      --sd-dialog-on-accent: #ffffff;
      --sd-dialog-primary: #0b62e4;
      --sd-dialog-primary-hover: #0a4fbf;
      --sd-dialog-danger: #d32f2f;
      --sd-dialog-danger-hover: #b71c1c;
      --sd-dialog-success: #00796c;
      --sd-dialog-success-hover: #00665b;
      --sd-dialog-danger-soft: rgb(229 57 53 / 0.1);
      --sd-dialog-danger-text: #c62828;
      --sd-dialog-warning-soft: rgb(242 169 0 / 0.16);
      --sd-dialog-warning-text: #8a5d00;
      --sd-dialog-info-soft: #e3f0fd;
      --sd-dialog-info-text: #0b62e4;
      --sd-dialog-success-soft: rgb(0 163 40 / 0.12);
      --sd-dialog-success-text: #00792a;

      box-sizing: border-box;
      /* The UA's :modal placement, kept while the closed dialog animates out. */
      position: fixed;
      inset: 0;
      flex-direction: column;
      width: 100%;
      max-width: 100%;
      max-height: 92vh;
      max-height: 92dvh;
      margin: auto 0 0;
      padding: 0 0 env(safe-area-inset-bottom, 0px);
      border: 0;
      border-radius: 16px 16px 0 0;
      background: var(--sd-dialog-surface);
      color: var(--sd-dialog-text);
      box-shadow: var(--sd-dialog-shadow);
      overflow: hidden;
      overscroll-behavior: contain;
    }
    .sd-dialog[open] {
      display: flex;
    }
    .sd-dialog:focus {
      outline: none;
    }
    .sd-dialog::backdrop {
      background: rgb(10 22 40 / 0.45);
    }
    .sd-dialog[data-state='closing'] {
      pointer-events: none;
    }

    /* Exit: the dialog is closed natively (page interactive, focus restored);
       overlay + display stay as they were until the fade/slide has finished. */
    .sd-dialog--leaving,
    .sd-dialog--leaving::backdrop {
      opacity: 0;
      transition-property: opacity, transform, overlay, display;
      transition-duration: 160ms;
      transition-timing-function: cubic-bezier(0.4, 0, 1, 1);
      transition-behavior: allow-discrete;
    }
    .sd-dialog--leaving {
      transform: translateY(100%);
      pointer-events: none;
    }

    @media (min-width: 40rem) {
      .sd-dialog {
        width: calc(100% - 2rem);
        max-height: calc(100vh - 2rem);
        max-height: calc(100dvh - 2rem);
        margin: auto;
        padding: 0;
        border-radius: 16px;
      }
      .sd-dialog--sm {
        max-width: 28rem;
      }
      .sd-dialog--md {
        max-width: 32rem;
      }
      .sd-dialog--lg {
        max-width: 42rem;
      }
      .sd-dialog--xl {
        max-width: 64rem;
      }
      /* [maxWidth]: an exact panel width from the design (e.g. 470 or 557px). */
      .sd-dialog--custom {
        max-width: var(--sd-dialog-max);
      }
      .sd-dialog--leaving {
        transform: translateY(8px) scale(0.98);
      }
    }

    :host-context(html[data-theme='dark']) .sd-dialog {
      --sd-dialog-surface: #161f2b;
      --sd-dialog-raised: #1c2633;
      --sd-dialog-hover: #212c39;
      --sd-dialog-text: #e5edf4;
      --sd-dialog-strong: #f2f7fb;
      --sd-dialog-muted: #94a6b5;
      --sd-dialog-border: #29323f;
      --sd-dialog-field: #5b6f80;
      --sd-dialog-ring: rgb(110 168 230 / 0.8);
      --sd-dialog-shadow:
        0 0 0 1px rgb(255 255 255 / 0.06), 0 12px 48px rgb(0 0 0 / 0.55);
      --sd-dialog-danger-soft: rgb(229 57 53 / 0.18);
      --sd-dialog-danger-text: #ff8a80;
      --sd-dialog-warning-soft: rgb(242 169 0 / 0.18);
      --sd-dialog-warning-text: #ffcc4d;
      --sd-dialog-info-soft: rgb(33 111 209 / 0.26);
      --sd-dialog-info-text: #8cbcff;
      --sd-dialog-success-soft: rgb(0 163 40 / 0.2);
      --sd-dialog-success-text: #6fdc8c;
      color-scheme: dark;
    }
    :host-context(html[data-theme='dark']) .sd-dialog::backdrop {
      background: rgb(0 0 0 / 0.6);
    }
  `,
  template: `
    @if (rendered()) {
      <dialog
        #dialog
        class="sd-dialog"
        [class]="sizeClass()"
        [style.--sd-dialog-max]="maxWidthCss()"
        [attr.role]="dialogRole()"
        aria-modal="true"
        tabindex="-1"
        [attr.aria-labelledby]="labelledById()"
        [attr.aria-describedby]="describedById()"
        [attr.aria-busy]="busy() || null"
        [attr.data-state]="closing() ? 'closing' : 'open'"
        (cancel)="onCancel($event)"
        (close)="onNativeClose()"
        (keydown)="onKeydown($event)"
        (pointerdown)="onPointerDown($event)"
        (click)="onClick($event)"
      >
        @if (layout() === 'standard') {
          <div class="flex shrink-0 items-start justify-between gap-3 border-b border-(--sd-dialog-border) px-5 py-4 sm:px-6">
            <div class="flex min-w-0 flex-col gap-0.5">
              <h2 [id]="titleId" class="break-words font-heading text-h5 text-(--sd-dialog-strong)">{{ title() }}</h2>
              @if (subtitle()) {
                <p [id]="subtitleId" class="font-sans text-body-sm text-(--sd-dialog-muted)">{{ subtitle() }}</p>
              }
            </div>
            @if (dismissible()) {
              <button
                type="button"
                class="-mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-(--sd-dialog-muted) transition-colors hover:bg-(--sd-dialog-hover) hover:text-(--sd-dialog-strong) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring) disabled:opacity-50"
                [attr.aria-label]="closeLabel()"
                [disabled]="busy()"
                (click)="dismiss()"
              >
                <sd-icon name="x" [size]="22" />
              </button>
            }
          </div>
        }
        <!-- One default slot only: Angular projects into the last one it finds. -->
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain" [class]="bodyClass()">
          <ng-content />
        </div>
        <ng-content select="[dialogFooter]" />
      </dialog>
    }
  `,
})
export class DialogComponent implements OnDestroy {
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  /** Whether the dialog is showing. The parent owns it: set it false on `closed`. */
  readonly open = input(false);
  /** Heading of the `standard` layout (and its accessible name). */
  readonly title = input('');
  /** Line under the title; describes the dialog. */
  readonly subtitle = input('');
  /** Max width from `sm` up (phones always get a full-width bottom sheet). */
  readonly size = input<DialogSize>('md');
  /** An exact max width in px from `sm` up, used instead of `size` (phones still get the sheet). */
  readonly maxWidth = input<number | null>(null);
  /** While true (a request is in flight) Esc, the scrim and × do nothing. */
  readonly busy = input(false);
  /** False: only the parent can close it (no ×, Esc and the scrim do nothing). */
  readonly dismissible = input(true);
  /** False: a click on the scrim does not close it (Esc and × still do). */
  readonly closeOnBackdrop = input(true);
  /** `alertdialog` for urgent / destructive prompts. */
  readonly dialogRole = input<DialogRole>('dialog');
  /** `standard`: header (title, subtitle, ×) + padded body. `plain`: the caller renders everything. */
  readonly layout = input<DialogLayout>('standard');
  /** Id of the element naming the dialog (defaults to the standard title). */
  readonly labelledBy = input<string | null>(null);
  /** Id(s) of the element(s) describing the dialog (defaults to the subtitle). */
  readonly describedBy = input<string | null>(null);
  /** Accessible label of the × button. */
  readonly closeLabel = input('Close');

  /** The user asked to close it (Esc, scrim, ×). Set `open` to false in response. */
  readonly closed = output<void>();
  /** Emitted once the dialog has fully closed (after its exit animation). */
  readonly afterClose = output<void>();

  protected readonly titleId = `sd-dialog-${++nextId}-title`;
  protected readonly subtitleId = `${this.titleId}-sub`;

  /** The `<dialog>` is in the DOM (open, or animating out). */
  protected readonly rendered = signal(false);
  protected readonly closing = signal(false);

  protected readonly sizeClass = computed(() =>
    this.maxWidth() ? 'sd-dialog--custom' : `sd-dialog--${this.size()}`,
  );
  protected readonly maxWidthCss = computed(() => {
    const px = this.maxWidth();
    return px ? `${px}px` : null;
  });
  protected readonly bodyClass = computed(() => (this.layout() === 'standard' ? 'px-5 py-5 sm:px-6' : ''));
  protected readonly labelledById = computed(
    () => this.labelledBy() ?? (this.layout() === 'standard' ? this.titleId : null),
  );
  protected readonly describedById = computed(
    () => this.describedBy() ?? (this.layout() === 'standard' && this.subtitle() ? this.subtitleId : null),
  );

  private readonly dialogRef = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private state: 'closed' | 'open' | 'closing' = 'closed';
  private returnTo: HTMLElement | null = null;
  private entryAnimations: Animation[] = [];
  /** Stops waiting for the exit transition (listeners + fallback timer). */
  private stopExitWait: (() => void) | null = null;
  /** We called `close()` ourselves: its (asynchronous) `close` event is not the platform's. */
  private selfClosed = false;
  private pressedOnBackdrop = false;

  constructor() {
    effect(() => {
      const open = this.open();
      untracked(() => (open ? this.show() : this.hide()));
    });
  }

  ngOnDestroy(): void {
    if (this.state === 'closed') return;
    this.stopExit();
    this.release();
    this.state = 'closed';
    this.restoreFocus(this.dialogRef()?.nativeElement ?? null);
  }

  /** Whether this is the topmost open dialog. */
  get isTopmost(): boolean {
    return openStack[openStack.length - 1] === this;
  }

  /**
   * After the body changed step: focus the new `[data-autofocus]` control (else
   * the first field, else the dialog) once it has rendered — unless the user is
   * already on a control inside the dialog.
   */
  refocus(): void {
    afterNextRender(
      () => {
        const dialog = this.dialogRef()?.nativeElement;
        const active = this.doc.activeElement;
        if (dialog && (!active || active === dialog || !dialog.contains(active))) this.focusInitial();
      },
      { injector: this.injector },
    );
  }

  /** Ask the parent to close (unless busy / not dismissible). */
  protected dismiss(): void {
    if (!this.busy() && this.dismissible()) this.closed.emit();
  }

  /** The platform's close request (Esc when nothing intercepted it, Android back…). */
  protected onCancel(event: Event): void {
    event.preventDefault();
    if (this.isTopmost) this.dismiss();
  }

  /**
   * The platform closed the dialog without us (a close request it would not let
   * us cancel). Show it again when it must stay; otherwise tell the parent.
   */
  protected onNativeClose(): void {
    if (this.selfClosed) {
      this.selfClosed = false;
      return;
    }
    // Closing / closed, or a stale event for a dialog that is showing again.
    if (this.state !== 'open' || this.dialogRef()?.nativeElement.open) return;
    if (!this.busy() && this.dismissible()) this.closed.emit();
    // Still meant to be open (busy, not dismissible, or the parent kept it): show it again.
    setTimeout(() => {
      const dialog = this.dialogRef()?.nativeElement;
      if (this.state === 'open' && dialog && !dialog.open) this.showNative(dialog);
    });
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // Handled here so the browser's own close request (which cannot always be
    // cancelled) never fires, and page-level Esc handlers behind stay quiet.
    event.preventDefault();
    event.stopPropagation();
    if (this.isTopmost) this.dismiss();
  }

  /**
   * Keys pressed while focus is outside the dialog — it fell to the page body
   * when the control that had it was removed. Esc still closes, and Tab comes
   * back into the dialog.
   */
  protected onDocKeydown(event: KeyboardEvent): void {
    if (this.state !== 'open' || !this.isTopmost) return;
    const dialog = this.dialogRef()?.nativeElement;
    const target = event.target;
    if (!dialog || (target instanceof Node && dialog.contains(target))) return;
    if (event.key === 'Escape') {
      if (event.defaultPrevented) return;
      event.preventDefault();
      this.dismiss();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const items = this.focusables(dialog);
      (items.length === 0 ? dialog : event.shiftKey ? items[items.length - 1] : items[0]).focus();
    }
  }

  protected onPointerDown(event: Event): void {
    this.pressedOnBackdrop = this.isBackdropEvent(event);
  }

  protected onClick(event: Event): void {
    const pressed = this.pressedOnBackdrop;
    this.pressedOnBackdrop = false;
    // Both ends of the click on the scrim (a text selection dragged out of the
    // panel does not count).
    if (!pressed || !this.isBackdropEvent(event)) return;
    if (this.closeOnBackdrop() && this.isTopmost) this.dismiss();
  }

  // ----- open / close -----

  private show(): void {
    if (this.state === 'open') return;
    const reopening = this.state === 'closing';
    this.state = 'open';
    if (reopening) {
      // Opened again mid-exit: take the closed, inert copy back.
      this.stopExit();
      const dialog = this.dialogRef()?.nativeElement;
      dialog?.classList.remove(LEAVING);
      dialog?.removeAttribute('inert');
      this.closing.set(false);
    } else {
      lockScroll(this.doc);
      this.rendered.set(true);
    }
    const active = this.doc.activeElement;
    const inside = active && this.dialogRef()?.nativeElement.contains(active);
    this.returnTo = active instanceof HTMLElement && active !== this.doc.body && !inside ? active : null;
    openStack.push(this);
    afterNextRender(
      () => {
        const dialog = this.dialogRef()?.nativeElement;
        if (this.state !== 'open' || !dialog) return;
        if (!dialog.open) this.showNative(dialog);
        this.focusInitial();
        this.animateIn(dialog);
      },
      { injector: this.injector },
    );
  }

  private hide(): void {
    if (this.state !== 'open') return;
    this.state = 'closing';
    removeFromStack(this);
    const dialog = this.dialogRef()?.nativeElement;
    if (!dialog) {
      this.restoreFocus(null);
      this.finishClose();
      return;
    }
    for (const a of this.entryAnimations) a.cancel();
    this.entryAnimations = [];
    const animate = dialog.open && this.motionAllowed(dialog) && canTransitionOut(this.doc);
    if (animate) dialog.classList.add(LEAVING);
    // Close natively right away, not after the animation: the page stops being
    // inert and the browser hands focus back to the opener now, so whatever the
    // closing action does with focus next sticks. The exit transition plays on
    // the closed dialog, which `overlay`/`display` keep in the top layer.
    this.closeNative(dialog);
    // No longer reachable by keyboard while it fades (and nothing to press twice).
    dialog.setAttribute('inert', '');
    this.restoreFocus(dialog);
    if (!animate) {
      this.finishClose();
      return;
    }
    this.closing.set(true);
    const onEnd = (event: Event): void => {
      if (event.target === dialog && (event as TransitionEvent).propertyName === 'opacity') done();
    };
    const done = (): void => {
      this.stopExit();
      if (this.state === 'closing') this.finishClose();
    };
    // A page that renders no frames (hidden / throttled) never ends the
    // transition: the fallback removes it anyway.
    const fallback = setTimeout(done, EXIT_MS + 100);
    dialog.addEventListener('transitionend', onEnd);
    dialog.addEventListener('transitioncancel', onEnd);
    this.stopExitWait = () => {
      clearTimeout(fallback);
      dialog.removeEventListener('transitionend', onEnd);
      dialog.removeEventListener('transitioncancel', onEnd);
    };
  }

  private finishClose(): void {
    this.stopExit();
    this.state = 'closed';
    const dialog = this.dialogRef()?.nativeElement;
    if (dialog) this.closeNative(dialog);
    this.closing.set(false);
    this.rendered.set(false);
    unlockScroll(this.doc);
    this.afterClose.emit();
  }

  private stopExit(): void {
    this.stopExitWait?.();
    this.stopExitWait = null;
  }

  /** Drop the stack entry and the scroll lock (on destroy). */
  private release(): void {
    removeFromStack(this);
    unlockScroll(this.doc);
  }

  private closeNative(dialog: HTMLDialogElement): void {
    if (!dialog.open) return;
    if (typeof dialog.close === 'function') {
      this.selfClosed = true;
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
  }

  private showNative(dialog: HTMLDialogElement): void {
    // Any `close` event still queued from our own close() is stale now.
    this.selfClosed = false;
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
        return;
      } catch {
        /* not connected / already open non-modally — fall through */
      }
    }
    dialog.setAttribute('open', '');
  }

  // ----- focus -----

  private focusInitial(): void {
    const dialog = this.dialogRef()?.nativeElement;
    if (!dialog) return;
    const wanted =
      dialog.querySelector<HTMLElement>('[data-autofocus]') ?? dialog.querySelector<HTMLElement>(FIELDS);
    (wanted ?? dialog).focus();
  }

  private focusables(dialog: HTMLElement): HTMLElement[] {
    const all = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[inert]'));
    const shown = all.filter((el) => el.getClientRects().length > 0);
    // No layout information at all (e.g. a test DOM): every candidate counts.
    return shown.length > 0 ? shown : all;
  }

  /**
   * Back to the opener — a fallback for when the browser did not do it (no
   * native modal, or the dialog was destroyed), and only when focus was lost
   * with the dialog: the closing action may have sent it somewhere on purpose.
   */
  private restoreFocus(dialog: HTMLElement | null): void {
    const target = this.returnTo;
    this.returnTo = null;
    if (!target) return;
    setTimeout(() => {
      if (this.state === 'open') return; // opened again meanwhile
      const active = this.doc.activeElement;
      const lost = !active || active === this.doc.body || (!!dialog && dialog.contains(active));
      if (target.isConnected && lost) target.focus();
    });
  }

  // ----- scrim -----

  private isBackdropEvent(event: Event): boolean {
    const dialog = this.dialogRef()?.nativeElement;
    if (!dialog || event.target !== dialog || !(event instanceof MouseEvent)) return false;
    const r = dialog.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  }

  // ----- motion -----

  private motionAllowed(dialog: HTMLElement): boolean {
    const view = this.doc.defaultView;
    return (
      typeof dialog.animate === 'function' &&
      typeof view?.matchMedia === 'function' &&
      !view.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  private isSheet(): boolean {
    return !(this.doc.defaultView?.matchMedia?.('(min-width: 40rem)').matches ?? true);
  }

  private animateIn(dialog: HTMLDialogElement): void {
    if (!this.motionAllowed(dialog)) return;
    const from = this.isSheet() ? 'translateY(100%)' : 'translateY(8px) scale(0.98)';
    const panel = dialog.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: 'none' }], {
      duration: 220,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    });
    const scrim = animateBackdrop(dialog, [{ opacity: 0 }, { opacity: 1 }], 220);
    this.entryAnimations = scrim ? [panel, scrim] : [panel];
  }
}

function removeFromStack(dialog: DialogComponent): void {
  const i = openStack.lastIndexOf(dialog);
  if (i >= 0) openStack.splice(i, 1);
}

function animateBackdrop(dialog: HTMLElement, frames: Keyframe[], duration: number): Animation | null {
  try {
    return dialog.animate(frames, { duration, pseudoElement: '::backdrop' });
  } catch {
    return null; // ::backdrop animation unsupported — the scrim just appears
  }
}

/**
 * Whether a closed `<dialog>` can stay in the top layer while it transitions
 * out (`overlay` + `transition-behavior: allow-discrete`). Without it the exit
 * is instant: animating it would drop the panel out of the top layer.
 */
function canTransitionOut(doc: Document): boolean {
  const css = doc.defaultView?.CSS;
  if (typeof css?.supports !== 'function') return false;
  try {
    return css.supports('transition-behavior', 'allow-discrete') && css.supports('overlay', 'auto');
  } catch {
    return false;
  }
}

function lockScroll(doc: Document): void {
  if (scrollLocks++ > 0) return;
  const root = doc.documentElement;
  const view = doc.defaultView;
  const hadScrollbar = !!view && view.innerWidth > root.clientWidth;
  savedRootStyle = { overflow: root.style.overflow, scrollbarGutter: root.style.getPropertyValue('scrollbar-gutter') };
  root.style.overflow = 'hidden';
  // Keep the space of a visible scrollbar so the page does not shift sideways.
  if (hadScrollbar) root.style.setProperty('scrollbar-gutter', 'stable');
}

function unlockScroll(doc: Document): void {
  if (scrollLocks === 0 || --scrollLocks > 0) return;
  const root = doc.documentElement;
  root.style.overflow = savedRootStyle?.overflow ?? '';
  if (savedRootStyle?.scrollbarGutter) root.style.setProperty('scrollbar-gutter', savedRootStyle.scrollbarGutter);
  else root.style.removeProperty('scrollbar-gutter');
  savedRootStyle = null;
}
