import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  NgZone,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { OtpComponent } from '@supadoc/ui';
import { Announcer } from '../core/announcer';

/** "9:05" / "09:59": minutes and seconds. */
export function mmss(totalSeconds: number, padMinutes = true): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  return `${padMinutes ? String(m).padStart(2, '0') : m}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A one-time code's two clocks: when it expires (`expires_in`) and when another
 * may be requested (`resend_after`). Ticks once a second while it lives.
 */
export class CodeTimer {
  private readonly now = signal(Date.now());
  private readonly expiresAt = signal<number | null>(null);
  private readonly resendAt = signal<number | null>(null);

  readonly remaining = computed(() => {
    const at = this.expiresAt();
    return at === null ? 0 : Math.max(0, Math.ceil((at - this.now()) / 1000));
  });
  readonly cooldown = computed(() => {
    const at = this.resendAt();
    return at === null ? 0 : Math.max(0, Math.ceil((at - this.now()) / 1000));
  });
  readonly running = computed(() => this.expiresAt() !== null);
  readonly expired = computed(() => this.expiresAt() !== null && this.remaining() === 0);

  /**
   * Call in an injection context. The tick runs outside the Angular zone (a
   * periodic task would keep the app from ever being stable); the signals
   * still refresh the views that read them.
   */
  constructor(destroyRef: DestroyRef, zone: NgZone | null = inject(NgZone, { optional: true })) {
    const start = () => setInterval(() => this.now.set(Date.now()), 1000);
    const id = zone ? zone.runOutsideAngular(start) : start();
    destroyRef.onDestroy(() => clearInterval(id));
  }

  /** A code was sent: it lives `expiresIn` s; another may be sent after `resendAfter` s. */
  start(expiresIn: number, resendAfter: number): void {
    const now = Date.now();
    this.now.set(now);
    this.expiresAt.set(now + expiresIn * 1000);
    this.resendAt.set(now + resendAfter * 1000);
  }

  /** A resend was refused for `seconds` more. */
  holdResend(seconds: number): void {
    const now = Date.now();
    this.now.set(now);
    this.resendAt.set(now + seconds * 1000);
  }

  stop(): void {
    this.expiresAt.set(null);
    this.resendAt.set(null);
  }
}

/**
 * The "Enter your code" body (Figma Track Application-2/-3): six compact boxes,
 * then "Code expires in 09:59. Resend code" (after a resend, "Resend in 0:45";
 * at zero, "Code expired. Resend code" and the boxes empty), then the error
 * line. The countdown is not read out; "Code expired" is announced once.
 */
@Component({
  selector: 'onb-code-entry',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OtpComponent, ReactiveFormsModule],
  host: { class: 'block' },
  template: `
    <sd-otp
      variant="compact"
      [formControl]="control()"
      [invalid]="invalid()"
      [describedBy]="error() ? errorId() : null"
    />
    <p class="mt-6 text-center font-sans text-body-sm text-slate">
      @if (timer().expired()) {
        Code expired.
      } @else {
        Code expires in <span class="font-medium text-ink">{{ remaining() }}.</span>
      }
      @if (timer().cooldown() > 0) {
        <span class="ml-1">Resend in {{ cooldown() }}</span>
      } @else {
        <button
          type="button"
          class="ml-1 rounded font-medium text-cerulean hover:text-cerulean-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:opacity-60"
          [disabled]="busy()"
          (click)="resend.emit()"
        >
          Resend code
        </button>
      }
    </p>
    @if (error()) {
      <p [id]="errorId()" role="alert" class="mt-2 text-center font-sans text-caption text-alert">{{ error() }}</p>
    }
  `,
})
export class CodeEntryComponent {
  private readonly announcer = inject(Announcer);

  readonly control = input.required<FormControl<string>>();
  readonly timer = input.required<CodeTimer>();
  readonly invalid = input(false);
  readonly error = input<string | null>(null);
  readonly busy = input(false);
  readonly errorId = input('onb-code-error');
  readonly resend = output<void>();

  private readonly otp = viewChild(OtpComponent);

  protected readonly remaining = computed(() => mmss(this.timer().remaining()));
  protected readonly cooldown = computed(() => mmss(this.timer().cooldown(), false));

  constructor() {
    // At zero: clear the boxes and say so once.
    effect(() => {
      if (!this.timer().expired()) return;
      untracked(() => {
        this.control().setValue('');
        this.announcer.announce('Code expired');
      });
    });
  }

  /** The D29 click on an incomplete code: focus where the code continues (the first empty box). */
  focus(): void {
    this.otp()?.focusFirstEmpty();
  }
}
