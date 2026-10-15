import { computed, Injectable, isDevMode, Signal, signal } from '@angular/core';
import { apiErrorMessage } from '@supadoc/data-access';
import { firstValueFrom, isObservable, Observable } from 'rxjs';
import type {
  ConfirmAutofocus,
  ConfirmDetail,
  ConfirmReasonOptions,
  ConfirmSecondaryAction,
  ConfirmTone,
} from '../confirm-dialog/confirm-dialog';
import type { DialogSize } from './dialog';

/** Work to run when the person confirms; the dialog stays open (busy) until it settles. */
export type DialogAction = (reason?: string) => Promise<unknown> | Observable<unknown>;

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Default `info`. `danger`/`warning` make it an `alertdialog` that focuses Cancel. */
  tone?: ConfirmTone;
  /** Lucide icon name; defaults to the tone's icon. */
  icon?: string;
  /** Facts to check before deciding (amount, account, date…). */
  details?: readonly ConfirmDetail[];
  /** Ask for a reason (validated; the trimmed text is passed to `action` and returned). */
  reason?: ConfirmReasonOptions;
  /** Default "Confirm". */
  confirmLabel?: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /**
   * A third action. Picking it resolves `{ confirmed: false, choice: value, reason? }`
   * (after its `action`, if any). With a reason field it validates the reason
   * and passes it to its `action` like confirm does, unless `ignoreReason`.
   */
  secondary?: ConfirmSecondaryAction & { action?: DialogAction };
  /**
   * Runs on confirm with the reason. While it runs the dialog shows a spinner
   * and cannot be dismissed; a failure is shown inline (via `errorMessage`) and
   * the person can retry or cancel. The promise resolves only after success.
   */
  action?: DialogAction;
  /** Turns an action's failure into text. Default `apiErrorMessage`. */
  errorMessage?: (err: unknown) => string;
  /** False: Esc and the scrim do nothing (Cancel still works). */
  dismissible?: boolean;
  /** Screen-reader text while the action runs. Default "Working…". */
  busyLabel?: string;
  autofocus?: ConfirmAutofocus;
  /** Default `sm`; use `md` for long details or a reason field on desktop. */
  size?: DialogSize;
}

export interface ConfirmResult {
  /** The primary action was chosen (and its `action` succeeded). */
  confirmed: boolean;
  /** The trimmed reason, when a reason field was shown and filled in (and the chosen action uses it). */
  reason?: string;
  /** The secondary action's `value`, when that was chosen. */
  choice?: string;
}

/** Copy for a "leave without saving?" prompt; every field has a default. */
export type LeaveCopy = Partial<
  Pick<ConfirmOptions, 'title' | 'message' | 'confirmLabel' | 'cancelLabel' | 'tone' | 'icon' | 'details'>
>;

export const DEFAULT_LEAVE_COPY: Required<Pick<LeaveCopy, 'title' | 'message' | 'confirmLabel' | 'cancelLabel' | 'tone'>> = {
  title: 'Leave without saving?',
  message: "Your changes haven't been saved. If you leave now, they'll be lost.",
  confirmLabel: 'Leave without saving',
  cancelLabel: 'Keep editing',
  tone: 'warning',
};

type Kind = 'confirm' | 'leave';

/**
 * One open (or closing) prompt rendered by `<sd-dialog-outlet>`. Its methods
 * are wired to the dialog's outputs; app code never needs them.
 */
export class DialogRequest {
  private readonly _open = signal(true);
  private readonly _busy = signal(false);
  private readonly _error = signal<string | null>(null);
  readonly open: Signal<boolean> = this._open.asReadonly();
  readonly busy: Signal<boolean> = this._busy.asReadonly();
  readonly error: Signal<string | null> = this._error.asReadonly();
  private settled = false;
  /** Bumped whenever a run starts or the request is settled, to ignore stale results. */
  private run = 0;

  constructor(
    readonly id: number,
    readonly kind: Kind,
    readonly options: ConfirmOptions,
    private readonly done: (result: ConfirmResult) => void,
    private readonly drop: (request: DialogRequest) => void,
  ) {}

  get isSettled(): boolean {
    return this.settled;
  }

  /** The confirm button (the reason is already validated by the dialog). */
  confirm(reason?: string): void {
    if (this.settled || this._busy()) return;
    const action = this.options.action;
    if (!action) {
      this.settle({ confirmed: true, ...(reason !== undefined ? { reason } : {}) });
      return;
    }
    void this.perform(action, reason, { confirmed: true, ...(reason !== undefined ? { reason } : {}) });
  }

  /** The secondary button (the reason is already validated by the dialog, unless `ignoreReason`). */
  choose(reason?: string): void {
    const secondary = this.options.secondary;
    if (this.settled || this._busy() || !secondary) return;
    const result: ConfirmResult = {
      confirmed: false,
      choice: secondary.value,
      ...(reason !== undefined ? { reason } : {}),
    };
    if (!secondary.action) {
      this.settle(result);
      return;
    }
    void this.perform(secondary.action, reason, result);
  }

  /** Cancel, Esc or the scrim (ignored while an action runs). */
  cancel(): void {
    if (!this.settled && !this._busy()) this.settle({ confirmed: false });
  }

  /** Close regardless of a running action (sign-out, navigation); resolves as not confirmed. */
  dismiss(): void {
    if (!this.settled) this.settle({ confirmed: false });
  }

  /** The dialog finished its exit animation: forget it. */
  release(): void {
    this.drop(this);
  }

  private async perform(action: DialogAction, reason: string | undefined, result: ConfirmResult): Promise<void> {
    const run = ++this.run;
    this._busy.set(true);
    this._error.set(null);
    try {
      const pending = action(reason);
      await (isObservable(pending) ? firstValueFrom(pending, { defaultValue: undefined }) : pending);
      if (run !== this.run) return;
      this._busy.set(false);
      this.settle(result);
    } catch (err) {
      if (run !== this.run) return;
      this._busy.set(false);
      this._error.set((this.options.errorMessage ?? apiErrorMessage)(err));
    }
  }

  private settle(result: ConfirmResult): void {
    this.settled = true;
    this.run++;
    this._busy.set(false);
    this._open.set(false);
    this.done(result);
  }
}

/**
 * Promise-based confirmations rendered by the app's single
 * `<sd-dialog-outlet />` (place it once in the root template, next to
 * `<router-outlet />`).
 *
 * ```ts
 * private readonly dialogs = inject(DialogService);
 *
 * async cancel(appt: Appointment) {
 *   const { confirmed } = await this.dialogs.confirm({
 *     tone: 'danger',
 *     title: `Cancel your appointment with Dr ${appt.doctorName}?`,
 *     message: '₦15,000 goes back to your wallet straight away. This can't be undone.',
 *     details: [{ label: 'When', value: 'Tue 21 Oct, 10:30' }],
 *     confirmLabel: 'Cancel appointment',
 *     cancelLabel: 'Keep it',
 *     action: () => this.api.cancel(appt.id), // spinner + inline apiErrorMessage until it succeeds
 *   });
 *   if (confirmed) this.reload();
 * }
 * ```
 *
 * Only one outlet should be mounted. Open prompts are dismissed (as not
 * confirmed) when a new router navigation starts, unless their action is
 * running.
 */
@Injectable({ providedIn: 'root' })
export class DialogService {
  private seq = 0;
  private outlets = 0;
  private readonly _requests = signal<readonly DialogRequest[]>([]);

  /** Prompts to render (including ones animating out). For `<sd-dialog-outlet>`. */
  readonly requests: Signal<readonly DialogRequest[]> = this._requests.asReadonly();
  /** Whether any prompt is open. */
  readonly hasOpen = computed(() => this._requests().some((r) => r.open()));

  /** Ask, and resolve with the answer (after `action` succeeded, when given). */
  confirm(options: ConfirmOptions): Promise<ConfirmResult> {
    return this.ask('confirm', options);
  }

  /**
   * "Leave without saving?" for `canLeave()` / guards: resolves true to leave.
   * A newer leave question answers an unanswered older one with "stay".
   */
  confirmLeave(copy: LeaveCopy = {}): Promise<boolean> {
    for (const r of this._requests()) if (r.kind === 'leave') r.dismiss();
    return this.ask('leave', { ...DEFAULT_LEAVE_COPY, ...copy }).then((r) => r.confirmed);
  }

  /**
   * Close open prompts, resolving them as not confirmed. `keepBusy` leaves the
   * ones whose action is still running (they close when it finishes).
   */
  dismissAll(options: { keepBusy?: boolean } = {}): void {
    for (const r of this._requests()) {
      if (options.keepBusy && r.busy()) continue;
      r.dismiss();
    }
  }

  /** @internal Called by `<sd-dialog-outlet>`; returns the unregister function. */
  registerOutlet(): () => void {
    this.outlets++;
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      this.outlets--;
      // Nothing can animate the prompts out any more.
      if (this.outlets === 0) {
        this.dismissAll();
        this._requests.set([]);
      }
    };
  }

  private ask(kind: Kind, options: ConfirmOptions): Promise<ConfirmResult> {
    if (this.outlets === 0 && isDevMode()) {
      console.warn(
        '[DialogService] No <sd-dialog-outlet /> is mounted: place one in the app root template, or this prompt never shows.',
      );
    }
    return new Promise<ConfirmResult>((resolve) => {
      const request = new DialogRequest(
        ++this.seq,
        kind,
        options,
        (result) => {
          resolve(result);
          // Without an outlet nobody reports the exit animation.
          if (this.outlets === 0) this.remove(request);
        },
        (r) => this.remove(r),
      );
      this._requests.update((list) => [...list, request]);
    });
  }

  private remove(request: DialogRequest): void {
    this._requests.update((list) => list.filter((r) => r !== request));
  }
}

