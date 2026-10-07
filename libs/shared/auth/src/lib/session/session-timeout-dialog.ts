import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { IconComponent } from '@supadoc/ui';
import { SessionTimeoutService } from './session-timeout.service';

/**
 * The "Are you still there?" warning shown before an idle sign-out. Drop it
 * once in the app's root template: `<sd-session-timeout />`. It renders nothing
 * until {@link SessionTimeoutService} raises the warning.
 */
@Component({
  selector: 'sd-session-timeout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
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
        <p class="min-w-0 flex-1 font-sans text-body-sm text-ink">
          <strong class="font-semibold">Your session ends at {{ deadlineTime() }}.</strong>
          For your security you'll need to sign in again then — save any work before that time.
        </p>
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
    @if (session.warning()) {
      <div class="fixed inset-0 z-[1000] flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-abyss/50 backdrop-blur-[2px]" aria-hidden="true"></div>
        <div
          class="relative z-10 flex w-full max-w-sm flex-col gap-4 rounded-[16px] bg-white p-6 text-center shadow-[0_8px_40px_rgba(10,22,40,0.25)]"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="sd-idle-title"
          aria-describedby="sd-idle-desc"
          (keydown.escape)="stay()"
        >
          <span class="mx-auto flex size-14 items-center justify-center rounded-full bg-warning/15 text-warning">
            <sd-icon name="clock" [size]="26" />
          </span>
          <div class="flex flex-col gap-1">
            <h2 id="sd-idle-title" class="font-heading text-h5 text-ink">Are you still there?</h2>
            <p id="sd-idle-desc" class="font-sans text-body-sm text-slate">
              For your security, you'll be signed out in
              <strong class="font-semibold text-ink tabular-nums" aria-live="polite">{{ countdown() }}</strong>
              because you've been inactive.
            </p>
          </div>
          <div class="mt-1 flex flex-col-reverse gap-3 sm:flex-row">
            <button
              type="button"
              class="flex-1 rounded-field border border-cloud py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier"
              (click)="session.signOutNow()"
            >
              Sign out
            </button>
            <button
              #stayBtn
              type="button"
              class="flex-1 rounded-field bg-cerulean py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-cerulean-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
              (click)="stay()"
            >
              Stay signed in
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class SessionTimeoutDialog {
  protected readonly session = inject(SessionTimeoutService);
  private readonly stayBtn = viewChild<ElementRef<HTMLButtonElement>>('stayBtn');

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

  constructor() {
    // Move focus into the dialog when it opens, so keyboard and screen-reader
    // users land on the primary action.
    effect(() => this.stayBtn()?.nativeElement.focus());
  }

  protected stay(): void {
    this.session.staySignedIn();
  }
}
