import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { APPLICATION_LANGUAGES, type ApplicationProfessional } from '@supadoc/models';
import { AlertComponent, SearchSelectComponent } from '@supadoc/ui';
import { SpecialtyOptions } from '../core/specialties';
import { validateSection } from '../core/validators';
import { CancelDialogComponent } from '../shared/cancel-dialog';
import { FieldComponent } from '../shared/field';
import { FormState } from '../shared/form-state';
import { MultiSelectComponent } from '../shared/multi-select';
import { NumberFieldComponent } from '../shared/number-field';
import { SavedDialogComponent } from '../shared/saved-dialog';
import { StepFooterComponent } from '../shared/step-footer';
import { StepShellComponent } from '../shared/step-shell';
import { onbButton, onbControl, onbTextarea } from '../shared/ui-classes';
import { FORM_SUBTITLE, StepBase } from './step-base';
import { intOrNull, str, textOrNull, trackEdits } from './step-helpers';

const FIELDS = ['specialty', 'years_experience', 'workplace', 'languages', 'bio'];
export const BIO_MAX = 280;

/** "{n}/280 · Shown to patients once you're approved". */
export function bioHelper(length: number): string {
  return `${length}/${BIO_MAX} · Shown to patients once you're approved`;
}

/** Step 2 of 7, Professional Details (Figma App 6/7). */
@Component({
  selector: 'onb-professional-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    CancelDialogComponent,
    FieldComponent,
    MultiSelectComponent,
    NumberFieldComponent,
    ReactiveFormsModule,
    SavedDialogComponent,
    SearchSelectComponent,
    StepFooterComponent,
    StepShellComponent,
  ],
  template: `
    <onb-step-shell [bare]="isInfo()" [step]="stepNumber()" [heading]="heading()" [subtitle]="subtitle" (back)="goBack()">
      @if (banner()) {
        <sd-alert tone="error" class="mt-6">{{ banner() }}</sd-alert>
      }
      @if (specialties.failed()) {
        <sd-alert tone="warning" class="mt-6">We couldn't load the list of specialities. Check your connection and reload the page.</sd-alert>
      }
      <form [formGroup]="fg" novalidate class="mt-8 grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2 min-[900px]:mt-10" (submit)="$event.preventDefault()">
        <onb-field #fSpec label="Primary speciality" forId="onb-specialty" [required]="true" [error]="form.shown('specialty')" (left)="form.touch('specialty')">
          <sd-search-select
            size="field"
            inputId="onb-specialty"
            searchPlaceholder="Search specialities"
            [clearable]="false"
            [options]="specialtyList()"
            [value]="values().specialty ?? ''"
            (valueChange)="fg.controls.specialty.setValue($event); form.touch('specialty')"
            [describedBy]="fSpec.describedBy()"
            [invalid]="!!form.shown('specialty')"
          />
        </onb-field>
        <onb-field #fYears label="Years of experience" forId="onb-years_experience" [required]="true" [error]="form.shown('years_experience')" (left)="form.touch('years_experience')">
          <onb-number-field formControlName="years_experience" inputId="onb-years_experience" placeholder="e.g. 8" [stepper]="true" [min]="0" [max]="60" [describedBy]="fYears.describedBy()" [invalid]="!!form.shown('years_experience')" />
        </onb-field>
        <onb-field #fWork label="Current workplace" forId="onb-workplace" [optional]="true" [error]="form.shown('workplace')" (left)="form.touch('workplace')">
          <input id="onb-workplace" formControlName="workplace" autocomplete="organization" maxlength="150" [class]="control('workplace')" [attr.aria-describedby]="fWork.describedBy()" [attr.aria-invalid]="!!form.shown('workplace') || null" />
        </onb-field>
        <onb-field #fLang label="Language" forId="onb-languages" [required]="true" [error]="form.shown('languages')" (left)="form.touch('languages')">
          <onb-multi-select formControlName="languages" inputId="onb-languages" [options]="languages" [describedBy]="fLang.describedBy()" [invalid]="!!form.shown('languages')" />
        </onb-field>
        <onb-field #fBio class="md:col-span-2" label="Short bio" forId="onb-bio" [required]="true" [hint]="bioHint()" [error]="form.shown('bio')" (left)="form.touch('bio')">
          <textarea id="onb-bio" formControlName="bio" rows="4" [attr.maxlength]="bioMax" [class]="textarea()" [attr.aria-describedby]="fBio.describedBy()" [attr.aria-invalid]="!!form.shown('bio') || null"></textarea>
          <span class="sr-only" aria-live="polite">{{ spokenCount() }}</span>
        </onb-field>
      </form>

      @if (wizard()) {
        <onb-step-footer stepFooter [primaryLabel]="primaryLabel()" [invalidLook]="form.invalid()" [busy]="busy()" (primary)="onContinue()" (save)="onSaveLater()" (cancelApplication)="onCancel()" />
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
export class OnbProfessionalStep extends StepBase {
  readonly key = 'professional' as const;
  protected readonly specialties = inject(SpecialtyOptions);
  protected readonly subtitle = FORM_SUBTITLE;
  protected readonly languages = APPLICATION_LANGUAGES;
  protected readonly bioMax = BIO_MAX;

  private readonly start = this.initialValues<Partial<ApplicationProfessional>>(this.source().sections()?.professional) ?? {};
  protected readonly fg = new FormGroup({
    specialty: new FormControl(str(this.start.specialty), { nonNullable: true }),
    years_experience: new FormControl<number | null>(intOrNull(this.start.years_experience)),
    workplace: new FormControl(str(this.start.workplace), { nonNullable: true }),
    languages: new FormControl<string[]>(Array.isArray(this.start.languages) ? [...this.start.languages] : [], {
      nonNullable: true,
    }),
    bio: new FormControl(str(this.start.bio), { nonNullable: true }),
  });
  protected readonly values = toSignal(this.fg.valueChanges, { initialValue: this.fg.getRawValue() });
  protected readonly form = new FormState(computed(() => this.validate(false)));
  protected readonly infoSaveClass = computed(() => `${onbButton('primary', this.form.invalid())} w-full sm:w-[200px]`);

  /** The saved specialty stays selectable even if the list no longer has it. */
  protected readonly specialtyList = computed(() => {
    const list = this.specialties.labels() ?? [];
    const current = this.start.specialty;
    return current && !list.includes(current) ? [current, ...list] : list;
  });

  private readonly bioLength = computed(() => [...(this.values().bio ?? '')].length);
  protected readonly bioHint = computed(() => bioHelper(this.bioLength()));
  /** The count for screen readers, updated at most every 2 s. */
  protected readonly spokenCount = signal('');
  private spokenAt = 0;
  private spokenTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    const destroyRef = inject(DestroyRef);
    trackEdits(this.fg, this.form, destroyRef);
    void this.specialties.load();
    this.markBaseline();
    this.fg.controls.bio.valueChanges.subscribe(() => this.speakCount());
    destroyRef.onDestroy(() => {
      if (this.spokenTimer) clearTimeout(this.spokenTimer);
    });
  }

  private speakCount(): void {
    const say = () => {
      this.spokenAt = Date.now();
      this.spokenTimer = null;
      this.spokenCount.set(`${this.bioLength()} of ${BIO_MAX} characters`);
    };
    const wait = 2000 - (Date.now() - this.spokenAt);
    if (wait <= 0) say();
    else if (!this.spokenTimer) this.spokenTimer = setTimeout(say, wait);
  }

  protected control(field: string): string {
    return onbControl(!!this.form.shown(field));
  }

  protected textarea(): string {
    return onbTextarea(!!this.form.shown('bio'));
  }

  protected validate(partial: boolean): Record<string, string> {
    this.values();
    return validateSection('professional', this.payload(), this.source().route(), this.today, partial, {
      specialties: this.specialties.labels(),
    });
  }

  protected payload(): Record<string, unknown> {
    const v = this.fg.getRawValue();
    return {
      specialty: v.specialty,
      years_experience: v.years_experience,
      workplace: textOrNull(v.workplace),
      languages: v.languages,
      bio: v.bio,
    };
  }

  protected fieldOrder(): string[] {
    return FIELDS;
  }
}
