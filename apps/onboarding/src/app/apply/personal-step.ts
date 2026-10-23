import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import type { ApplicationPersonal } from '@supadoc/models';
import { AlertComponent, PhoneInputComponent, SearchSelectComponent, WORLD_COUNTRIES } from '@supadoc/ui';
import { minusYears } from '../core/format';
import { MESSAGES, validateSection } from '../core/validators';
import { CancelDialogComponent } from '../shared/cancel-dialog';
import { DateFieldComponent } from '../shared/date-field';
import { FieldComponent } from '../shared/field';
import { FormState } from '../shared/form-state';
import { SavedDialogComponent } from '../shared/saved-dialog';
import { type SelectOption, SelectComponent } from '../shared/select';
import { StepFooterComponent } from '../shared/step-footer';
import { StepShellComponent } from '../shared/step-shell';
import { onbButton, onbControl } from '../shared/ui-classes';
import { FORM_SUBTITLE, StepBase } from './step-base';
import { str, trackEdits } from './step-helpers';

export const GENDER_OPTIONS: SelectOption[] = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
];

export const COUNTRY_OPTIONS = WORLD_COUNTRIES.map((c) => ({ value: c.iso, label: c.name }));

const FIELDS = ['first_name', 'last_name', 'email', 'phone', 'date_of_birth', 'gender', 'country_of_residence', 'city'];

/** Step 1 of 7, Personal Details (Figma App 4/5): a 2×4 grid. */
@Component({
  selector: 'onb-personal-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    CancelDialogComponent,
    DateFieldComponent,
    FieldComponent,
    PhoneInputComponent,
    ReactiveFormsModule,
    SavedDialogComponent,
    SearchSelectComponent,
    SelectComponent,
    StepFooterComponent,
    StepShellComponent,
  ],
  template: `
    <onb-step-shell
      [bare]="isInfo()"
      [step]="stepNumber()"
      [heading]="heading()"
      [subtitle]="subtitle"
      (back)="goBack()"
    >
      @if (banner()) {
        <sd-alert tone="error" class="mt-6">{{ banner() }}</sd-alert>
      }
      <form
        [formGroup]="fg"
        novalidate
        class="mt-8 grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2 min-[900px]:mt-10"
        (submit)="$event.preventDefault()"
      >
        <onb-field #fFirst label="First name" forId="onb-first_name" [required]="true" [error]="form.shown('first_name')" (left)="form.touch('first_name')">
          <input id="onb-first_name" formControlName="first_name" autocomplete="given-name" maxlength="100" [class]="control('first_name')" [attr.aria-describedby]="fFirst.describedBy()" [attr.aria-invalid]="!!form.shown('first_name') || null" />
        </onb-field>
        <onb-field #fLast label="Last name" forId="onb-last_name" [required]="true" [error]="form.shown('last_name')" (left)="form.touch('last_name')">
          <input id="onb-last_name" formControlName="last_name" autocomplete="family-name" maxlength="100" [class]="control('last_name')" [attr.aria-describedby]="fLast.describedBy()" [attr.aria-invalid]="!!form.shown('last_name') || null" />
        </onb-field>
        <onb-field #fEmail label="Email" forId="onb-email" [required]="true" hint="We'll send application updates here." [error]="form.shown('email')" (left)="form.touch('email')">
          <input id="onb-email" type="email" formControlName="email" autocomplete="email" inputmode="email" maxlength="254" placeholder="name@example.com" [readOnly]="isInfo()" [class]="control('email')" [attr.aria-describedby]="fEmail.describedBy()" [attr.aria-invalid]="!!form.shown('email') || null" />
        </onb-field>
        <onb-field #fPhone label="Phone number" forId="onb-phone" [required]="true" hint="We'll text you status updates." [error]="form.shown('phone')" (left)="form.touch('phone')">
          <sd-phone-input formControlName="phone" size="md" placeholder="803 123 4567" [countries]="countries" inputId="onb-phone" [describedBy]="fPhone.describedBy()" [invalid]="!!form.shown('phone')" />
        </onb-field>
        <onb-field #fDob label="Date of birth" forId="onb-date_of_birth" [required]="true" [error]="form.shown('date_of_birth')" (left)="form.touch('date_of_birth')">
          <onb-date-field formControlName="date_of_birth" inputId="onb-date_of_birth" [max]="maxDob" [describedBy]="fDob.describedBy()" [invalid]="!!form.shown('date_of_birth')" />
        </onb-field>
        <onb-field #fGender label="Gender" forId="onb-gender" [required]="true" [error]="form.shown('gender')" (left)="form.touch('gender')">
          <onb-select formControlName="gender" inputId="onb-gender" [options]="genders" [describedBy]="fGender.describedBy()" [invalid]="!!form.shown('gender')" />
        </onb-field>
        <onb-field #fCountry label="Country of residence" forId="onb-country_of_residence" [required]="true" [error]="form.shown('country_of_residence')" (left)="form.touch('country_of_residence')">
          <sd-search-select
            size="field"
            inputId="onb-country_of_residence"
            searchPlaceholder="Search countries"
            [clearable]="false"
            [options]="countryOptions"
            [value]="values().country_of_residence ?? ''"
            (valueChange)="fg.controls.country_of_residence.setValue($event); form.touch('country_of_residence')"
            [describedBy]="fCountry.describedBy()"
            [invalid]="!!form.shown('country_of_residence')"
          />
        </onb-field>
        <onb-field #fCity label="City" forId="onb-city" [required]="true" [error]="form.shown('city')" (left)="form.touch('city')">
          <input id="onb-city" formControlName="city" autocomplete="address-level2" maxlength="100" [class]="control('city')" [attr.aria-describedby]="fCity.describedBy()" [attr.aria-invalid]="!!form.shown('city') || null" />
        </onb-field>
      </form>

      @if (wizard()) {
        <onb-step-footer
          stepFooter
          [primaryLabel]="primaryLabel()"
          [invalidLook]="form.invalid()"
          [busy]="busy()"
          (primary)="onContinue()"
          (save)="onSaveLater()"
          (cancelApplication)="onCancel()"
        />
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
export class OnbPersonalStep extends StepBase {
  readonly key = 'personal' as const;
  protected readonly subtitle = FORM_SUBTITLE;
  protected readonly countries = WORLD_COUNTRIES;
  protected readonly countryOptions = COUNTRY_OPTIONS;
  protected readonly genders = GENDER_OPTIONS;
  protected readonly maxDob = minusYears(this.today, 21);

  private readonly start = this.initialValues<Partial<ApplicationPersonal>>(this.source().sections()?.personal) ?? {};
  protected readonly fg = new FormGroup({
    first_name: new FormControl(str(this.start.first_name), { nonNullable: true }),
    last_name: new FormControl(str(this.start.last_name), { nonNullable: true }),
    email: new FormControl(str(this.start.email), { nonNullable: true }),
    phone: new FormControl(str(this.start.phone), { nonNullable: true }),
    date_of_birth: new FormControl(str(this.start.date_of_birth), { nonNullable: true }),
    gender: new FormControl(str(this.start.gender), { nonNullable: true }),
    country_of_residence: new FormControl(str(this.start.country_of_residence) || 'NG', { nonNullable: true }),
    city: new FormControl(str(this.start.city), { nonNullable: true }),
  });
  protected readonly values = toSignal(this.fg.valueChanges, { initialValue: this.fg.getRawValue() });
  protected readonly form = new FormState(computed(() => this.validate(false)));
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
    return validateSection('personal', this.payload(), this.source().route(), this.today, partial);
  }

  protected payload(): Record<string, unknown> {
    return { ...this.fg.getRawValue() };
  }

  protected fieldOrder(): string[] {
    return FIELDS;
  }

  /** Before a draft exists, Save & continue later creates it, so the email must be valid. */
  protected override partialProblems(): Record<string, string> {
    const errors = this.validate(true);
    if (!this.store.hasToken() && !this.fg.controls.email.value.trim()) errors['email'] = MESSAGES.email;
    return errors;
  }

  protected override async persist(partial: boolean): Promise<void> {
    await this.store.savePersonal(this.payload(), partial);
  }
}
