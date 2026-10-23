import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import type { ApplicationIndemnity } from '@supadoc/models';
import { AlertComponent } from '@supadoc/ui';
import { slotCopy } from '../core/documents';
import { addDays } from '../core/format';
import { documentInSlot } from '../core/step-source';
import { validateSection } from '../core/validators';
import { CancelDialogComponent } from '../shared/cancel-dialog';
import { DateFieldComponent } from '../shared/date-field';
import { FieldComponent } from '../shared/field';
import { FileFieldComponent } from '../shared/file-field';
import { FormState } from '../shared/form-state';
import { SavedDialogComponent } from '../shared/saved-dialog';
import { StepFooterComponent } from '../shared/step-footer';
import { StepShellComponent } from '../shared/step-shell';
import { onbButton, onbControl } from '../shared/ui-classes';
import { FORM_SUBTITLE, StepBase } from './step-base';
import { str, trackEdits } from './step-helpers';

const FIELDS = ['provider', 'policy_number', 'cover_expires_on'];
const SLOT = 'indemnity_certificate' as const;

/** Step 6 of 7, Indemnity (Figma App 14/15): provider, policy number, cover expiry and the certificate. */
@Component({
  selector: 'onb-indemnity-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    CancelDialogComponent,
    DateFieldComponent,
    FieldComponent,
    FileFieldComponent,
    ReactiveFormsModule,
    SavedDialogComponent,
    StepFooterComponent,
    StepShellComponent,
  ],
  template: `
    <onb-step-shell [bare]="isInfo()" [step]="stepNumber()" [heading]="heading()" [subtitle]="subtitle" (back)="goBack()">
      @if (banner()) {
        <sd-alert tone="error" class="mt-6">{{ banner() }}</sd-alert>
      }
      <form [formGroup]="fg" novalidate class="mt-8 grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2 min-[900px]:mt-10" (submit)="$event.preventDefault()">
        <onb-field #fProv class="md:col-span-2" label="Indemnity provider" forId="onb-provider" [required]="true" [error]="form.shown('provider')" (left)="form.touch('provider')">
          <input id="onb-provider" formControlName="provider" autocomplete="off" maxlength="150" placeholder="e.g. Medical Protection Society" [class]="control('provider')" [attr.aria-describedby]="fProv.describedBy()" [attr.aria-invalid]="!!form.shown('provider') || null" />
        </onb-field>
        <onb-field #fPol label="Policy number" forId="onb-policy_number" [required]="true" [error]="form.shown('policy_number')" (left)="form.touch('policy_number')">
          <input id="onb-policy_number" formControlName="policy_number" autocomplete="off" spellcheck="false" maxlength="60" [class]="control('policy_number')" [attr.aria-describedby]="fPol.describedBy()" [attr.aria-invalid]="!!form.shown('policy_number') || null" />
        </onb-field>
        <onb-field #fExp label="Cover expiry date" forId="onb-cover_expires_on" [required]="true" [error]="form.shown('cover_expires_on')" (left)="form.touch('cover_expires_on')">
          <onb-date-field formControlName="cover_expires_on" inputId="onb-cover_expires_on" [min]="tomorrow" [describedBy]="fExp.describedBy()" [invalid]="!!form.shown('cover_expires_on')" />
        </onb-field>
        <onb-file-field
          class="md:col-span-2"
          inputId="onb-indemnity_certificate"
          [label]="copy.label"
          [hint]="copy.hint"
          [required]="true"
          [document]="certificate()"
          [progress]="uploads.progressOf(slot)"
          [error]="uploads.errorOf(slot)"
          [readonly]="!source().slotEditable(slot)"
          [removable]="certificate() ? source().documentRemovable(certificate()!) : true"
          (pick)="uploads.pick(slot, $event)"
          (remove)="removeCertificate()"
          (view)="viewCertificate()"
        />
      </form>

      @if (wizard()) {
        <onb-step-footer stepFooter [primaryLabel]="primaryLabel()" [invalidLook]="incomplete()" [busy]="busy()" (primary)="onContinue()" (save)="onSaveLater()" (cancelApplication)="onCancel()" />
      } @else {
        <div stepFooter class="mt-6 flex justify-end">
          <button type="button" [class]="infoSaveClass()" [attr.aria-disabled]="form.invalid() || null" [attr.aria-busy]="busy() || null" (click)="onInfoSave()">Save</button>
        </div>
      }
    </onb-step-shell>

    @if (wizard()) {
      <onb-saved-dialog [open]="savedOpen()" [sentTo]="savedTo()" [cooldown]="savedCooldown()" (home)="savedHome()" (keepGoing)="savedOpen.set(false)" />
      <onb-cancel-dialog [open]="cancelOpen()" mode="draft" [busy]="cancelBusy()" [error]="cancelError()" (confirm)="confirmCancel()" (closed)="cancelOpen.set(false)" />
    }
  `,
})
export class OnbIndemnityStep extends StepBase {
  readonly key = 'indemnity' as const;
  protected readonly subtitle = FORM_SUBTITLE;
  protected readonly slot = SLOT;
  protected readonly copy = slotCopy(SLOT, 'ng');
  protected readonly tomorrow = addDays(this.today, 1);

  private readonly start = this.initialValues<Partial<ApplicationIndemnity>>(this.source().sections()?.indemnity) ?? {};
  protected readonly fg = new FormGroup({
    provider: new FormControl(str(this.start.provider), { nonNullable: true }),
    policy_number: new FormControl(str(this.start.policy_number), { nonNullable: true }),
    cover_expires_on: new FormControl(str(this.start.cover_expires_on), { nonNullable: true }),
  });
  protected readonly values = toSignal(this.fg.valueChanges, { initialValue: this.fg.getRawValue() });
  protected readonly form = new FormState(computed(() => this.validate(false)));
  protected readonly certificate = computed(() => documentInSlot(this.source().documents(), SLOT));
  protected readonly incomplete = computed(() => this.form.invalid() || (this.wizard() && !this.certificate()));
  protected readonly infoSaveClass = computed(() => `${onbButton('primary', this.form.invalid())} w-full sm:w-[200px]`);

  constructor() {
    super();
    trackEdits(this.fg, this.form, inject(DestroyRef));
    this.markBaseline();
  }

  protected control(field: string): string {
    return onbControl(!!this.form.shown(field));
  }

  protected validate(partial: boolean): Record<string, string> {
    this.values();
    return validateSection('indemnity', this.payload(), this.source().route(), this.today, partial);
  }

  protected payload(): Record<string, unknown> {
    return { ...this.fg.getRawValue() };
  }

  protected fieldOrder(): string[] {
    return FIELDS;
  }

  protected override missingUploads(): string[] {
    return this.wizard() && !this.certificate() ? [SLOT] : [];
  }

  protected removeCertificate(): void {
    const doc = this.certificate();
    if (doc) void this.uploads.remove(doc);
  }

  protected viewCertificate(): void {
    const doc = this.certificate();
    if (doc) this.source().viewDocument(doc);
  }
}
