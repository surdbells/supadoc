import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DialogComponent, IconComponent } from '@supadoc/ui';
import { SessionTimeoutService } from './session-timeout.service';

/**
 * The "Are you still there?" warning shown before an idle sign-out. Drop it
 * once in the app's root template: `<sd-session-timeout />`. It renders nothing
 * until {@link SessionTimeoutService} raises the warning.
 */
@Component({
  selector: 'sd-session-timeout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, IconComponent],
  template: `
    @if (session.deadlineSoon() && !session.warning()) {
      <div
        class="fixed inset-x-0 top-3 z-[999] mx-auto flex w-[min(100%-1.5rem,32rem)] items-start gap-3 rounded-[16px] border border-warning/40 bg-white p-4 shadow-[0_8px_30px_rgba(10,22,40,0.18)]"
        role="status"
        aria-live="polite"
      >
        <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
          <sd-icon name="clock" [size]="18" />
        </span>
        <div class="min-w-0 flex-1 font-sans text-body-sm text-ink">
          @if (session.holding()) {
            <p>
              <strong class="font-semibold">Your sign-in ends at {{ deadlineTime() }}.</strong>
              Your call carries on. To keep saving to your account after that time, sign in again in a
              new tab — this call isn't interrupted.
            </p>
            <button
              type="button"
              class="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-field bg-cerulean px-3 py-1.5 font-semibold text-white transition-colors hover:bg-cerulean-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
              (click)="signInInNewTab()"
            >
              <sd-icon name="external-link" [size]="16" /> Sign in again (new tab)
            </button>
          } @else {
            <p>
              <strong class="font-semibold">Your session ends at {{ deadlineTime() }}.</strong>
              For your security you'll need to sign in again then — save any work before that time.
            </p>
          }
        </div>
        <button
          type="button"
          class="shrink-0 rounded-full p-1 text-slate transition-colors hover:bg-glacier hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
          aria-label="Dismiss"
          (click)="session.dismissDeadlineNotice()"
        >
          <sd-icon name="x" [size]="18" />
        </button>
      </div>
    }
    <!-- A native modal (top layer): opened last, it sits above any other open
         dialog, and only the explicit buttons or Esc ("stay") answer it. -->
    <sd-dialog
      [open]="session.warning()"
      layout="plain"
      size="sm"
      dialogRole="alertdialog"
      labelledBy="sd-idle-title"
      describedBy="sd-idle-desc"
      [closeOnBackdrop]="false"
      (closed)="stay()"
    >
      <div class="flex flex-col gap-4 p-6 text-center">
        <span class="mx-auto flex size-14 items-center justify-center rounded-full bg-(--sd-dialog-warning-soft) text-(--sd-dialog-warning-text)">
          <sd-icon name="clock" [size]="26" />
        </span>
        <div class="flex flex-col gap-1">
          <h2 id="sd-idle-title" class="font-heading text-h5 text-(--sd-dialog-strong)">Are you still there?</h2>
          <p id="sd-idle-desc" class="font-sans text-body-sm text-(--sd-dialog-muted)">
            For your security, you'll be signed out in
            <strong class="font-semibold text-(--sd-dialog-strong) tabular-nums" aria-live="polite">{{ countdown() }}</strong>
            because you've been inactive.
          </p>
        </div>
        <div class="mt-1 flex flex-col-reverse gap-3 sm:flex-row">
          <button
            type="button"
            class="min-h-12 flex-1 rounded-field border border-(--sd-dialog-border) py-3 font-sans text-body font-semibold text-(--sd-dialog-muted) transition-colors hover:bg-(--sd-dialog-hover) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring)"
            (click)="session.signOutNow()"
          >
            Sign out
          </button>
          <button
            type="button"
            data-autofocus
            class="min-h-12 flex-1 rounded-field bg-(--sd-dialog-primary) py-3 font-sans text-body font-semibold text-(--sd-dialog-on-accent) transition-colors hover:bg-(--sd-dialog-primary-hover) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring) focus-visible:ring-offset-2"
            (click)="stay()"
          >
            Stay signed in
          </button>
        </div>
      </div>
    </sd-dialog>
  `,
})
export class SessionTimeoutDialog {
  protected readonly session = inject(SessionTimeoutService);

  protected readonly deadlineTime = computed(() => {
    const at = this.session.deadlineSoon();
    return at === null
      ? ''
      : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(at));
  });

  protected readonly countdown = computed(() => {
    const s = this.session.secondsLeft();
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  protected stay(): void {
    this.session.staySignedIn();
  }

  /**
   * The sign-in page in a NEW tab, so a live call is never interrupted. The new
   * session reaches this tab by itself (shared storage).
   */
  protected signInInNewTab(): void {
    window.open(this.session.loginUrl, '_blank', 'noopener');
  }
}
