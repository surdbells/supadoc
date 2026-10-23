import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import type { ApplicationLicenceAbroad, ApplicationLicenceNg } from '@supadoc/models';
import { AlertComponent, IconComponent, SearchSelectComponent } from '@supadoc/ui';
import { licenceSlot, slotCopy } from '../core/documents';
import { addDays, goodStandingMinDate } from '../core/format';
import { documentInSlot } from '../core/step-source';
import { goodStandingMessage, validateSection } from '../core/validators';
import { CancelDialogComponent } from '../shared/cancel-dialog';
import { DateFieldComponent } from '../shared/date-field';
import { FieldComponent } from '../shared/field';
import { FileFieldComponent } from '../shared/file-field';
import { FormState } from '../shared/form-state';
import { NumberFieldComponent } from '../shared/number-field';
import { SavedDialogComponent } from '../shared/saved-dialog';
import { StepFooterComponent } from '../shared/step-footer';
import { StepShellComponent } from '../shared/step-shell';
import { onbButton, onbControl } from '../shared/ui-classes';
import { COUNTRY_OPTIONS } from './personal-step';
import { FORM_SUBTITLE, StepBase } from './step-base';
import { intOrNull, str, trackEdits } from './step-helpers';

const NG_FIELDS = ['mdcn_number', 'full_registration_year', 'licence_expires_on'];
const ABROAD_FIELDS = ['regulator_country', 'regulator_name', 'registration_number', 'good_standing_issued_on'];

/** Step 3 of 7: Licence · Nigeria (Figma App 8/9 + the D3 certificate) or Licence · Abroad (App 20/22). */
@Component({
  selector: 'onb-licence-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    CancelDialogComponent,
    DateFieldComponent,
    FieldComponent,
    FileFieldComponent,
    IconComponent,
    NumberFieldComponent,
    ReactiveFormsModule,
    SavedDialogComponent,
    SearchSelectComponent,
    StepFooterComponent,
    StepShellComponent,
  ],
  template: `
    <onb-step-shell [bare]="isInfo()" [step]="stepNumber()" [heading]="heading()" [subtitle]="subtitle" (back)="goBack()">
      @if (route() === 'ng') {
        <div
          class="mt-4 flex min-h-12 items-center gap-4 rounded-field bg-[linear-gradient(90deg,#BBDEFB_50%,#90CAF9_100%)] px-4 py-3"
        >
          <sd-icon name="shield-check" [size]="24" [strokeWidth]="1.5" class="shrink-0 text-cerulean" />
          <p class="font-sans text-body-sm text-ocean">
            We verify your registration directly with the Medical and Dental Council of Nigeria (MDCN)
          </p>
        </div>
      }
      @if (banner()) {
        <sd-alert tone="error" class="mt-6">{{ banner() }}</sd-alert>
      }
      <form [formGroup]="fg" novalidate class="mt-8 grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2 min-[900px]:mt-10" (submit)="$event.preventDefault()">
        @if (route() === 'ng') {
          <onb-field #fMdcn label="MDCN registration number" forId="onb-mdcn_number" [required]="true" [error]="form.shown('mdcn_number')" (left)="form.touch('mdcn_number')">
            <input id="onb-mdcn_number" formControlName="mdcn_number" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40" placeholder="e.g. MDCN/R/123456" [class]="control('mdcn_number')" [attr.aria-describedby]="fMdcn.describedBy()" [attr.aria-invalid]="!!form.shown('mdcn_number') || null" />
          </onb-field>
          <onb-field #fYear label="Year of full registration" forId="onb-full_registration_year" [required]="true" [error]="form.shown('full_registration_year')" (left)="form.touch('full_registration_year')">
            <onb-number-field formControlName="full_registration_year" inputId="onb-full_registration_year" placeholder="e.g. 2016" [min]="1960" [max]="currentYear" [describedBy]="fYear.describedBy()" [invalid]="!!form.shown('full_registration_year')" />
          </onb-field>
          <onb-field #fExp label="Annual practising licence expiry" forId="onb-licence_expires_on" [required]="true" [error]="form.shown('licence_expires_on')" (left)="form.touch('licence_expires_on')">
            <onb-date-field formControlName="licence_expires_on" inputId="onb-licence_expires_on" [min]="tomorrow" [describedBy]="fExp.describedBy()" [invalid]="!!form.shown('licence_expires_on')" />
          </onb-field>
        } @else {
          <onb-field #fCountry label="Country of your regulator" forId="onb-regulator_country" [required]="true" [error]="form.shown('regulator_country')" (left)="form.touch('regulator_country')">
            <sd-search-select
              size="field"
              inputId="onb-regulator_country"
              searchPlaceholder="Search countries"
              [clearable]="false"
              [options]="regulatorCountries"
              [value]="values().regulator_country ?? ''"
              (valueChange)="fg.controls.regulator_country.setValue($event); form.touch('regulator_country')"
              [describedBy]="fCountry.describedBy()"
              [invalid]="!!form.shown('regulator_country')"
            />
          </onb-field>
          <onb-field #fReg label="Regulator" forId="onb-regulator_name" [required]="true" [error]="form.shown('regulator_name')" (left)="form.touch('regulator_name')">
            <input id="onb-regulator_name" formControlName="regulator_name" autocomplete="off" maxlength="150" placeholder="e.g. General Medical Council" [class]="control('regulator_name')" [attr.aria-describedby]="fReg.describedBy()" [attr.aria-invalid]="!!form.shown('regulator_name') || null" />
          </onb-field>
          <onb-field #fNum label="Licence or registration number" forId="onb-registration_number" [required]="true" [error]="form.shown('registration_number')" (left)="form.touch('registration_number')">
            <input id="onb-registration_number" formControlName="registration_number" autocomplete="off" spellcheck="false" maxlength="40" [class]="control('registration_number')" [attr.aria-describedby]="fNum.describedBy()" [attr.aria-invalid]="!!form.shown('registration_number') || null" />
          </onb-field>
          <onb-field #fGs label="Certificate of Good Standing — issue date" forId="onb-good_standing_issued_on" [required]="true" [hint]="goodStandingHint" [error]="form.shown('good_standing_issued_on')" (left)="form.touch('good_standing_issued_on')">
            <onb-date-field formControlName="good_standing_issued_on" inputId="onb-good_standing_issued_on" [min]="goodStandingMin" [max]="today" [describedBy]="fGs.describedBy()" [invalid]="!!form.shown('good_standing_issued_on')" />
          </onb-field>
        }
        <onb-file-field
          class="md:col-span-2"
          [inputId]="'onb-' + certSlot()"
          [label]="certCopy().label"
          [hint]="certCopy().hint"
          [required]="true"
          [document]="certificate()"
          [progress]="uploads.progressOf(certSlot())"
          [error]="uploads.errorOf(certSlot())"
          [readonly]="!source().slotEditable(certSlot())"
          [removable]="certificate() ? source().documentRemovable(certificate()!) : true"
          (pick)="uploads.pick(certSlot(), $event)"
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
export class OnbLicenceStep extends StepBase {
  readonly key = 'licence' as const;
  protected readonly subtitle = FORM_SUBTITLE;
  protected readonly currentYear = Number(this.today.slice(0, 4));
  protected readonly tomorrow = addDays(this.today, 1);
  protected readonly goodStandingMin = goodStandingMinDate(this.today);
  protected readonly goodStandingHint = goodStandingMessage(this.today);
  protected readonly regulatorCountries = COUNTRY_OPTIONS.filter((c) => c.value !== 'NG');

  protected readonly route = computed(() => this.source().route());
  protected readonly certSlot = computed(() => licenceSlot(this.route()));
  protected readonly certCopy = computed(() => slotCopy(this.certSlot(), this.route()));

  private readonly start =
    this.initialValues<Partial<ApplicationLicenceNg & ApplicationLicenceAbroad>>(this.source().sections()?.licence) ?? {};
  protected readonly fg = new FormGroup({
    mdcn_number: new FormControl(str(this.start.mdcn_number), { nonNullable: true }),
    full_registration_year: new FormControl<number | null>(intOrNull(this.start.full_registration_year)),
    licence_expires_on: new FormControl(str(this.start.licence_expires_on), { nonNullable: true }),
    regulator_country: new FormControl(str(this.start.regulator_country), { nonNullable: true }),
    regulator_name: new FormControl(str(this.start.regulator_name), { nonNullable: true }),
    registration_number: new FormControl(str(this.start.registration_number), { nonNullable: true }),
    good_standing_issued_on: new FormControl(str(this.start.good_standing_issued_on), { nonNullable: true }),
  });
  protected readonly values = toSignal(this.fg.valueChanges, { initialValue: this.fg.getRawValue() });
  protected readonly form = new FormState(computed(() => this.validate(false)));
  protected readonly certificate = computed(() => documentInSlot(this.source().documents(), this.certSlot()));
  /** The fields are valid and (in the wizard) the certificate is there. */
  protected readonly incomplete = computed(() => this.form.invalid() || (this.wizard() && !this.certificate()));
  protected readonly infoSaveClass = computed(() => `${onbButton('primary', this.form.invalid())} w-full sm:w-[200px]`);

  constructor() {
    super();
    trackEdits(this.fg, this.form, inject(DestroyRef));
    this.fg.controls.mdcn_number.valueChanges.subscribe((v) => {
      const upper = v.toUpperCase();
      if (upper !== v) this.fg.controls.mdcn_number.setValue(upper, { emitEvent: false });
    });
    this.markBaseline();
  }

  protected control(field: string): string {
    return onbControl(!!this.form.shown(field));
  }

  protected validate(partial: boolean): Record<string, string> {
    this.values();
    return validateSection('licence', this.payload(), this.route(), this.today, partial);
  }

  protected payload(): Record<string, unknown> {
    const v = this.fg.getRawValue();
    return this.route() === 'ng'
      ? {
          mdcn_number: v.mdcn_number.toUpperCase(),
          full_registration_year: v.full_registration_year,
          licence_expires_on: v.licence_expires_on,
        }
      : {
          regulator_country: v.regulator_country,
          regulator_name: v.regulator_name,
          registration_number: v.registration_number,
          good_standing_issued_on: v.good_standing_issued_on,
        };
  }

  protected fieldOrder(): string[] {
    return this.route() === 'ng' ? NG_FIELDS : ABROAD_FIELDS;
  }

  protected override missingUploads(): string[] {
    return this.wizard() && !this.certificate() ? [this.certSlot()] : [];
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
