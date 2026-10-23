import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { APPLICATION_REFERENCE_PATTERN, type ApplicantChannel, type TrackChannelDto } from '@supadoc/models';
import { AlertComponent, DialogComponent, IconComponent } from '@supadoc/ui';
import { apiErrorCode, bannerMessage, retryAfterMs } from '../core/errors';
import { NOTICE, Notices } from '../core/notices';
import { TrackStore } from '../core/track.store';
import { CodeEntryComponent, CodeTimer } from '../shared/code-entry';
import { FieldComponent } from '../shared/field';
import { ModalHeaderComponent } from '../shared/modal-header';
import { RadioCardComponent } from '../shared/radio-card';
import { onbControl, onbModalButton } from '../shared/ui-classes';

export type TrackStep = 'find' | 'method' | 'code';

const REFERENCE_ERROR = 'Enter your reference number, e.g. GVM-DR-2026-12345.';
const CONTACT_ERROR = 'Enter the email or phone number you applied with.';
const CODE_INVALID = "That code isn't right. Check it and try again.";

/** Upper case, spaces collapsed to "-" (as the API's ApplicationReference::normalise). */
export function normaliseReference(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '-');
}

/** "We sent a 6-digit code to …": a masked destination, or the generic wording lower-cased. */
export function codeSubtitle(sentTo: string): string {
  const generic = /^The (phone number|email address) on your application$/.test(sentTo);
  const to = generic ? `the ${sentTo.slice(4)}` : sentTo;
  return `We sent a 6-digit code to ${to}. It expires in 10 minutes.`;
}

/**
 * "Check your application status" (Figma Track Application, 470px), one modal
 * in three steps: find (reference + contact) → method (SMS / Email) → code
 * (6 digits). Success stores the access token and opens /status.
 */
@Component({
  selector: 'onb-track-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    CodeEntryComponent,
    DialogComponent,
    FieldComponent,
    IconComponent,
    ModalHeaderComponent,
    RadioCardComponent,
    ReactiveFormsModule,
  ],
  template: `
    <sd-dialog
      [open]="open()"
      layout="plain"
      [maxWidth]="470"
      [busy]="busy()"
      labelledBy="onb-track-title"
      describedBy="onb-track-subtitle"
      (closed)="close()"
    >
      <div class="p-6">
        @switch (step()) {
          @case ('find') {
            <form novalidate (submit)="$event.preventDefault(); find()">
              <onb-modal-header
                baseId="onb-track"
                title="Check your application status"
                subtitle="Enter your reference number and the email or phone number you applied with."
                [busy]="busy()"
                (closed)="close()"
              />
              @if (notice()) {
                <sd-alert tone="info" class="mt-4">{{ notice() }}</sd-alert>
              }
              <div class="mt-6 flex flex-col gap-6">
                <onb-field #fRef label="Reference number" forId="onb-track-reference" [required]="true" [error]="refError()">
                  <input
                    id="onb-track-reference"
                    type="text"
                    autocapitalize="characters"
                    autocomplete="off"
                    spellcheck="false"
                    maxlength="24"
                    placeholder="GVM-DR-2026-12345"
                    data-autofocus
                    [formControl]="reference"
                    [class]="refClass()"
                    [attr.aria-describedby]="fRef.describedBy()"
                    [attr.aria-invalid]="!!refError() || null"
                    (blur)="refTouched.set(true)"
                  />
                </onb-field>
                <onb-field #fContact label="Email or phone number" forId="onb-track-contact" [required]="true" [error]="contactError()">
                  <input
                    id="onb-track-contact"
                    type="text"
                    inputmode="email"
                    autocomplete="email"
                    maxlength="254"
                    [formControl]="contact"
                    [class]="contactClass()"
                    [attr.aria-describedby]="fContact.describedBy()"
                    [attr.aria-invalid]="!!contactError() || null"
                    (blur)="contactTouched.set(true)"
                  />
                </onb-field>
              </div>
              @if (error()) {
                <sd-alert tone="error" class="mt-4">{{ error() }}</sd-alert>
              }
              <div class="mt-10 flex justify-center">
                <button type="submit" [class]="primaryClass(!findValid())" [attr.aria-disabled]="!findValid() || null" [attr.aria-busy]="busy() || null">
                  @if (busy()) {
                    <sd-icon name="loader-circle" [size]="16" class="animate-spin" />
                  }
                  Check status
                </button>
              </div>
            </form>
          }
          @case ('method') {
            <onb-modal-header
              baseId="onb-track"
              title="Verify it’s you"
              subtitle="For your security, we’ll send a one-time code before showing your status. Where should we send it?"
              [busy]="busy()"
              (closed)="close()"
            />
            <fieldset class="mt-6 flex min-w-0 flex-col gap-6">
              <legend class="sr-only">Where should we send the code?</legend>
              @for (c of channels(); track c.channel) {
                <onb-radio-card
                  variant="channel"
                  name="track-channel"
                  [value]="c.channel"
                  [title]="c.channel === 'sms' ? 'Text message (SMS)' : 'Email'"
                  [description]="c.destination"
                  [checked]="chosen() === c.channel"
                  (picked)="chosen.set($any($event))"
                >
                  <sd-icon cardIcon [name]="c.channel === 'sms' ? 'phone' : 'mail'" [size]="20" [strokeWidth]="1.5" />
                </onb-radio-card>
              }
            </fieldset>
            @if (error()) {
              <sd-alert tone="error" class="mt-4">{{ error() }}</sd-alert>
            }
            <div class="mt-10 flex justify-center">
              <button type="button" [class]="primaryClass(!chosen())" [attr.aria-disabled]="!chosen() || null" [attr.aria-busy]="busy() || null" (click)="sendCode()">
                @if (busy()) {
                  <sd-icon name="loader-circle" [size]="16" class="animate-spin" />
                }
                Send code
              </button>
            </div>
          }
          @case ('code') {
            <form novalidate (submit)="$event.preventDefault(); verify()">
              <onb-modal-header baseId="onb-track" title="Enter your code" [subtitle]="codeText()" [busy]="busy()" (closed)="close()" />
              <div class="mt-6">
                <onb-code-entry
                  [control]="code"
                  [timer]="timer"
                  [invalid]="wrongCode()"
                  [error]="error()"
                  [busy]="busy()"
                  errorId="onb-track-code-error"
                  (resend)="sendCode(true)"
                />
              </div>
              <div class="mt-10 flex justify-center">
                <button type="submit" [class]="primaryClass(!codeComplete())" [attr.aria-disabled]="!codeComplete() || null" [attr.aria-busy]="busy() || null">
                  @if (busy()) {
                    <sd-icon name="loader-circle" [size]="16" class="animate-spin" />
                  }
                  Verify and check status
                </button>
              </div>
              <p class="mt-4 text-center">
                <button type="button" class="rounded font-sans text-body-sm text-slate hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40" (click)="useDifferentMethod()">
                  Use a different method
                </button>
              </p>
            </form>
          }
        }
      </div>
    </sd-dialog>
  `,
})
export class TrackDialogComponent {
  private readonly track = inject(TrackStore);
  private readonly router = inject(Router);
  private readonly notices = inject(Notices);

  readonly open = input(false);
  readonly closed = output<void>();

  protected readonly step = signal<TrackStep>('find');
  protected readonly reference = new FormControl('', { nonNullable: true });
  protected readonly contact = new FormControl('', { nonNullable: true });
  protected readonly code = new FormControl('', { nonNullable: true });
  private readonly refValue = toSignal(this.reference.valueChanges, { initialValue: '' });
  private readonly contactValue = toSignal(this.contact.valueChanges, { initialValue: '' });
  private readonly codeValue = toSignal(this.code.valueChanges, { initialValue: '' });
  protected readonly refTouched = signal(false);
  protected readonly contactTouched = signal(false);
  private readonly submitted = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly wrongCode = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly chosen = signal<ApplicantChannel | null>(null);
  protected readonly channels = signal<TrackChannelDto[]>([]);
  protected readonly sentTo = signal('');
  protected readonly timer = new CodeTimer(inject(DestroyRef));
  private readonly dialog = viewChild(DialogComponent);
  private readonly codeEntry = viewChild(CodeEntryComponent);

  private readonly refOk = computed(() => APPLICATION_REFERENCE_PATTERN.test(normaliseReference(this.refValue())));
  private readonly contactOk = computed(() => this.contactValue().trim().length >= 5);
  protected readonly findValid = computed(() => this.refOk() && this.contactOk());
  protected readonly codeComplete = computed(() => /^\d{6}$/.test(this.codeValue()));
  protected readonly refError = computed(() => ((this.refTouched() || this.submitted()) && !this.refOk() ? REFERENCE_ERROR : null));
  protected readonly contactError = computed(() =>
    (this.contactTouched() || this.submitted()) && !this.contactOk() ? CONTACT_ERROR : null,
  );
  protected readonly refClass = computed(() => `${onbControl(!!this.refError())} uppercase`);
  protected readonly contactClass = computed(() => onbControl(!!this.contactError()));
  protected readonly codeText = computed(() => codeSubtitle(this.sentTo()));

  constructor() {
    effect(() => {
      if (!this.open()) return;
      untracked(() => this.reset());
    });
  }

  protected primaryClass(inert: boolean): string {
    return `${onbModalButton('primary', inert)} w-full sm:w-[247px]`;
  }

  private reset(): void {
    this.step.set('find');
    this.error.set(null);
    this.wrongCode.set(false);
    this.submitted.set(false);
    this.refTouched.set(false);
    this.contactTouched.set(false);
    this.code.setValue('');
    this.timer.stop();
    this.notice.set(this.notices.take('track'));
    const prefill = this.track.prefillReference();
    if (prefill) {
      this.reference.setValue(prefill);
      this.track.prefill(null);
    }
  }

  protected close(): void {
    this.timer.stop();
    this.closed.emit();
  }

  private goTo(step: TrackStep): void {
    this.step.set(step);
    this.dialog()?.refocus();
  }

  async find(): Promise<void> {
    if (this.busy()) return;
    this.submitted.set(true);
    this.error.set(null);
    if (!this.findValid()) {
      document.getElementById(this.refOk() ? 'onb-track-contact' : 'onb-track-reference')?.focus();
      return;
    }
    this.busy.set(true);
    try {
      const reference = normaliseReference(this.reference.value);
      this.reference.setValue(reference);
      const channels = await this.track.start(reference, this.contact.value.trim());
      this.channels.set(channels);
      this.chosen.set(this.track.chosen());
      this.goTo('method');
    } catch (err) {
      this.error.set(bannerMessage(err, "We couldn't check that right now. Please try again."));
    } finally {
      this.busy.set(false);
    }
  }

  async sendCode(resend = false): Promise<void> {
    const channel = this.chosen();
    if (this.busy()) return;
    if (!channel) {
      this.error.set('Choose where we should send the code.');
      document.querySelector<HTMLInputElement>('input[name="track-channel"]')?.focus();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.wrongCode.set(false);
    try {
      const sent = await this.track.requestCode(channel);
      this.sentTo.set(sent.sent_to);
      this.timer.start(sent.expires_in, sent.resend_after);
      this.code.setValue('');
      if (!resend) this.goTo('code');
    } catch (err) {
      const code = apiErrorCode(err);
      if (code === 'track_expired') return this.expired();
      if (code === 'resend_cooldown') {
        this.timer.holdResend(Math.ceil((retryAfterMs(err) ?? 60_000) / 1000));
      }
      this.error.set(bannerMessage(err, "We couldn't send a code. Please try again."));
    } finally {
      this.busy.set(false);
    }
  }

  async verify(): Promise<void> {
    if (this.busy()) return;
    if (!this.codeComplete()) {
      this.error.set('Enter the 6-digit code.');
      this.codeEntry()?.focus();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.wrongCode.set(false);
    try {
      await this.track.verify(this.code.value);
      this.timer.stop();
      this.closed.emit();
      await this.router.navigateByUrl('/status');
    } catch (err) {
      const code = apiErrorCode(err);
      if (code === 'track_expired') return this.expired();
      this.wrongCode.set(code === 'code_invalid');
      this.error.set(code === 'code_invalid' ? CODE_INVALID : bannerMessage(err, "We couldn't check the code. Please try again."));
      if (code === 'code_expired' || code === 'code_locked') this.code.setValue('');
    } finally {
      this.busy.set(false);
    }
  }

  protected useDifferentMethod(): void {
    this.error.set(null);
    this.wrongCode.set(false);
    this.goTo('method');
  }

  private expired(): void {
    this.timer.stop();
    this.track.reset();
    this.notice.set(NOTICE.trackExpired);
    this.error.set(null);
    this.goTo('find');
  }
}
