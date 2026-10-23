import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import type { ApplicationConsent } from '@supadoc/models';
import { AlertComponent } from '@supadoc/ui';
import { validateSection } from '../core/validators';
import { CancelDialogComponent } from '../shared/cancel-dialog';
import { ConsentCardComponent } from '../shared/consent-card';
import { FieldComponent } from '../shared/field';
import { FormState } from '../shared/form-state';
import { SavedDialogComponent } from '../shared/saved-dialog';
import { StepFooterComponent } from '../shared/step-footer';
import { StepShellComponent } from '../shared/step-shell';
import { onbControl } from '../shared/ui-classes';
import { StepBase } from './step-base';
import { str, trackEdits } from './step-helpers';

const TICKS = ['accept_terms', 'authorise_verification', 'confirm_accurate'] as const;
const FIELDS = [...TICKS, 'signature_name'];

/** Step 7 of 7, Consent (Figma App 16–18, Component 134). */
@Component({
  selector: 'onb-consent-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    CancelDialogComponent,
    ConsentCardComponent,
    FieldComponent,
    ReactiveFormsModule,
    SavedDialogComponent,
    StepFooterComponent,
    StepShellComponent,
  ],
  template: `
    <onb-step-shell [bare]="isInfo()" [step]="stepNumber()" [heading]="heading()" (back)="goBack()">
      <div stepIntro class="mt-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <!-- prettier-ignore -->
        <p class="font-sans text-body-sm text-slate">Tick each statement to confirm. (Fields marked <span class="text-alert">*</span> are required)</p>
        <button
          type="button"
          class="-mx-1 rounded px-1 font-sans text-body text-cerulean hover:text-cerulean-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
          [attr.aria-pressed]="allTicked()"
          (click)="toggleAll()"
        >
          {{ allTicked() ? 'Unmark all' : 'Mark all' }}
        </button>
      </div>

      @if (banner()) {
        <sd-alert tone="error" class="mt-6">{{ banner() }}</sd-alert>
      }
      <form [formGroup]="fg" novalidate class="mt-8 flex flex-col gap-6 min-[900px]:mt-10" (submit)="$event.preventDefault()">
        <fieldset class="flex min-w-0 flex-col gap-6" [attr.aria-describedby]="tickError() ? 'onb-consent-error' : null">
          <legend class="sr-only">Consent statements (all required)</legend>
          <onb-consent-card inputId="onb-accept_terms" [checked]="values().accept_terms === true" [invalid]="!!form.shown('accept_terms')" (changed)="setTick('accept_terms', $event)">
            I accept the
            @if (config().legal_terms_url; as terms) {
              <a [href]="terms" target="_blank" rel="noopener noreferrer" class="font-medium text-cerulean underline underline-offset-2">Terms of Service</a>
            } @else {
              Terms of Service
            }
            and
            @if (config().legal_privacy_url; as privacy) {
              <a [href]="privacy" target="_blank" rel="noopener noreferrer" class="font-medium text-cerulean underline underline-offset-2">Privacy Policy</a>.
            } @else {
              Privacy Policy.
            }
          </onb-consent-card>
          <onb-consent-card inputId="onb-authorise_verification" [checked]="values().authorise_verification === true" [invalid]="!!form.shown('authorise_verification')" (changed)="setTick('authorise_verification', $event)">
            I authorise VideoMed to verify my licence, qualifications and indemnity with the relevant regulators and issuing bodies.
          </onb-consent-card>
          <onb-consent-card inputId="onb-confirm_accurate" [checked]="values().confirm_accurate === true" [invalid]="!!form.shown('confirm_accurate')" (changed)="setTick('confirm_accurate', $event)">
            I confirm the information and documents I've provided are accurate and complete.
          </onb-consent-card>
          @if (tickError()) {
            <p id="onb-consent-error" role="alert" class="-mt-3 font-label text-caption text-alert">{{ tickError() }}</p>
          }
        </fieldset>

        <onb-field #fSig label="Type your full name as your signature" forId="onb-signature_name" [required]="true" [error]="form.shown('signature_name')" (left)="form.touch('signature_name')">
          <input id="onb-signature_name" formControlName="signature_name" autocomplete="name" maxlength="200" placeholder="e.g. Ada Obi Okafor" [class]="control('signature_name')" [attr.aria-describedby]="fSig.describedBy()" [attr.aria-invalid]="!!form.shown('signature_name') || null" />
        </onb-field>
      </form>

      @if (wizard()) {
        <onb-step-footer
          stepFooter
          [primaryLabel]="returnMode() ? 'Save and return' : 'Review your application'"
          [primaryWidth]="250"
          [invalidLook]="form.invalid()"
          [busy]="busy()"
          (primary)="onContinue()"
          (save)="onSaveLater()"
          (cancelApplication)="onCancel()"
        />
      }
    </onb-step-shell>

    @if (wizard()) {
      <onb-saved-dialog [open]="savedOpen()" [sentTo]="savedTo()" [cooldown]="savedCooldown()" (home)="savedHome()" (keepGoing)="savedOpen.set(false)" />
      <onb-cancel-dialog [open]="cancelOpen()" mode="draft" [busy]="cancelBusy()" [error]="cancelError()" (confirm)="confirmCancel()" (closed)="cancelOpen.set(false)" />
    }
  `,
})
export class OnbConsentStep extends StepBase {
  readonly key = 'consent' as const;
  protected readonly config = this.configStore.config;

  private readonly start = this.initialValues<Partial<ApplicationConsent>>(this.source().sections()?.consent) ?? {};
  protected readonly fg = new FormGroup({
    accept_terms: new FormControl(this.start.accept_terms === true, { nonNullable: true }),
    authorise_verification: new FormControl(this.start.authorise_verification === true, { nonNullable: true }),
    confirm_accurate: new FormControl(this.start.confirm_accurate === true, { nonNullable: true }),
    signature_name: new FormControl(str(this.start.signature_name), { nonNullable: true }),
  });
  protected readonly values = toSignal(this.fg.valueChanges, { initialValue: this.fg.getRawValue() });
  protected readonly form = new FormState(computed(() => this.validate(false)));
  protected readonly allTicked = computed(() => {
    const v = this.values();
    return v.accept_terms === true && v.authorise_verification === true && v.confirm_accurate === true;
  });
  protected readonly tickError = computed(() => TICKS.map((k) => this.form.shown(k)).find((m) => !!m) ?? null);

  constructor() {
    super();
    trackEdits(this.fg, this.form, inject(DestroyRef));
    void this.configStore.load();
    this.markBaseline();
  }

  protected setTick(key: (typeof TICKS)[number], on: boolean): void {
    this.fg.controls[key].setValue(on);
    this.form.touch(key);
  }

  protected toggleAll(): void {
    const on = !this.allTicked();
    for (const k of TICKS) this.fg.controls[k].setValue(on);
    for (const k of TICKS) this.form.touch(k);
    this.announcer.announce(on ? 'All statements ticked.' : 'All statements unticked.');
  }

  protected control(field: string): string {
    return onbControl(!!this.form.shown(field));
  }

  protected validate(partial: boolean): Record<string, string> {
    this.values();
    return validateSection('consent', this.payload(), this.source().route(), this.today, partial, {
      personal: this.source().sections()?.personal ?? null,
    });
  }

  // Save & continue later uses StepBase's defaults: a partial consent (unticked
  // boxes, a blank signature) saves like any other step (§2.11, partial skips
  // "required" only); a signature that doesn't match the names still blocks it.

  protected payload(): Record<string, unknown> {
    return { ...this.fg.getRawValue(), consent_version: this.config().consent_version };
  }

  protected fieldOrder(): string[] {
    return FIELDS;
  }
}
