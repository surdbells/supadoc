import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormArray, FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import type { ApplicationQualification, ApplicationQualifications } from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';
import { MAX_QUALIFICATIONS, validateSection } from '../core/validators';
import { CancelDialogComponent } from '../shared/cancel-dialog';
import { FieldComponent } from '../shared/field';
import { FormState } from '../shared/form-state';
import { NumberFieldComponent } from '../shared/number-field';
import { SavedDialogComponent } from '../shared/saved-dialog';
import { StepFooterComponent } from '../shared/step-footer';
import { StepShellComponent } from '../shared/step-shell';
import { ONB_TEXT_BUTTON, onbButton, onbControl } from '../shared/ui-classes';
import { FORM_SUBTITLE, StepBase } from './step-base';
import { intOrNull, str } from './step-helpers';

export { MAX_QUALIFICATIONS };

type EntryGroup = FormGroup<{
  degree: FormControl<string>;
  institution: FormControl<string>;
  year_awarded: FormControl<number | null>;
}>;

function entryGroup(q?: Partial<ApplicationQualification>): EntryGroup {
  return new FormGroup({
    degree: new FormControl(str(q?.degree), { nonNullable: true }),
    institution: new FormControl(str(q?.institution), { nonNullable: true }),
    year_awarded: new FormControl<number | null>(intOrNull(q?.year_awarded)),
  });
}

/** Step 4 of 7, Qualifications (Figma App 10/11, Component 133): the primary degree plus up to nine more. */
@Component({
  selector: 'onb-qualifications-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    CancelDialogComponent,
    FieldComponent,
    IconComponent,
    NumberFieldComponent,
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
      <!-- Boxes 32px apart; "Add qualification" 16px under the last box (UI spec §1). -->
      <form [formGroup]="fg" novalidate class="mt-8 flex flex-col gap-4 min-[900px]:mt-10" (submit)="$event.preventDefault()">
        <div formArrayName="entries" class="flex flex-col gap-8">
          @for (entry of entries.controls; track entry; let i = $index) {
            <fieldset [formGroupName]="i" class="relative min-w-0 rounded-lg border border-haze bg-snow px-2 pb-4 pt-4">
              <legend class="float-left flex min-h-6 w-full items-center px-1 pr-12 font-sans text-body-sm font-medium text-ink">
                {{ boxTitle(i) }}
              </legend>
              @if (i > 0) {
                <button
                  type="button"
                  class="absolute right-1 top-2 inline-flex size-10 items-center justify-center rounded-full text-alert hover:bg-alert/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-alert/40"
                  [attr.aria-label]="'Remove additional qualification ' + i"
                  (click)="remove(i)"
                >
                  <sd-icon name="trash-2" [size]="20" [strokeWidth]="1.5" />
                </button>
              }
              <div class="clear-both grid grid-cols-1 gap-x-2 gap-y-4 pt-2 md:grid-cols-3">
                <onb-field #fDeg label="Degree" [forId]="id(i, 'degree')" [required]="true" [error]="form.shown(entryKey(i, 'degree'))" (left)="form.touch(entryKey(i, 'degree'))">
                  <input [id]="id(i, 'degree')" formControlName="degree" maxlength="100" placeholder="e.g. MBBS" [class]="control(i, 'degree')" [attr.aria-describedby]="fDeg.describedBy()" [attr.aria-invalid]="!!form.shown(entryKey(i, 'degree')) || null" />
                </onb-field>
                <onb-field #fInst label="Institution" [forId]="id(i, 'institution')" [required]="true" [error]="form.shown(entryKey(i, 'institution'))" (left)="form.touch(entryKey(i, 'institution'))">
                  <input [id]="id(i, 'institution')" formControlName="institution" maxlength="150" placeholder="e.g. University or college" [class]="control(i, 'institution')" [attr.aria-describedby]="fInst.describedBy()" [attr.aria-invalid]="!!form.shown(entryKey(i, 'institution')) || null" />
                </onb-field>
                <onb-field #fYear label="Year awarded" [forId]="id(i, 'year_awarded')" [required]="true" [error]="form.shown(entryKey(i, 'year_awarded'))" (left)="form.touch(entryKey(i, 'year_awarded'))">
                  <onb-number-field formControlName="year_awarded" [inputId]="id(i, 'year_awarded')" placeholder="e.g. 2014" [min]="1950" [max]="currentYear" [describedBy]="fYear.describedBy()" [invalid]="!!form.shown(entryKey(i, 'year_awarded'))" />
                </onb-field>
              </div>
            </fieldset>
          }
        </div>
        @if (entries.length < max) {
          <button id="onb-add-qualification" type="button" [class]="addClass" (click)="add()">
            <sd-icon name="plus" [size]="20" [strokeWidth]="1.5" />
            Add qualification
          </button>
        } @else {
          <p class="font-label text-caption text-slate">You can add up to {{ max }} qualifications.</p>
        }
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
export class OnbQualificationsStep extends StepBase {
  readonly key = 'qualifications' as const;
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly subtitle = FORM_SUBTITLE;
  protected readonly max = MAX_QUALIFICATIONS;
  protected readonly currentYear = Number(this.today.slice(0, 4));
  protected readonly addClass = `${ONB_TEXT_BUTTON} ml-4 h-10 w-fit text-body-sm`;

  private readonly start = this.initialValues<ApplicationQualifications>(this.source().sections()?.qualifications);
  protected readonly entries = new FormArray<EntryGroup>(
    (this.start?.entries?.length ? this.start.entries : [{}]).slice(0, MAX_QUALIFICATIONS).map((q) => entryGroup(q)),
  );
  protected readonly fg = new FormGroup({ entries: this.entries });
  /** Bumped on add / remove so the error computation sees the new shape. */
  private readonly shape = signal(0);
  protected readonly values = toSignal(this.fg.valueChanges, { initialValue: this.fg.getRawValue() });
  protected readonly form = new FormState(computed(() => this.validate(false)));
  protected readonly infoSaveClass = computed(() => `${onbButton('primary', this.form.invalid())} w-full sm:w-[200px]`);

  constructor() {
    super();
    this.fg.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      // Any edit clears the server's answer for the edited entry fields.
      const server = this.form.server();
      if (Object.keys(server).length) this.form.setServer({});
    });
    this.markBaseline();
  }

  protected boxTitle(i: number): string {
    return i === 0 ? 'Primary Medical Degree' : `Additional Qualification ${i}`;
  }

  protected entryKey(i: number, field: string): string {
    return `entries.${i}.${field}`;
  }

  protected id(i: number, field: string): string {
    return `onb-entries-${i}-${field}`;
  }

  protected control(i: number, field: string): string {
    return onbControl(!!this.form.shown(this.entryKey(i, field)));
  }

  protected add(): void {
    if (this.entries.length >= MAX_QUALIFICATIONS) return;
    this.entries.push(entryGroup());
    this.shape.update((n) => n + 1);
    const i = this.entries.length - 1;
    afterNextRender(() => document.getElementById(this.id(i, 'degree'))?.focus(), { injector: this.injector });
    this.announcer.announce(`Additional qualification ${i} added.`);
  }

  protected remove(i: number): void {
    if (i === 0) return;
    this.entries.removeAt(i);
    this.shape.update((n) => n + 1);
    this.form.setServer({});
    afterNextRender(() => document.getElementById('onb-add-qualification')?.focus(), { injector: this.injector });
    this.announcer.announce(`Additional qualification ${i} removed.`);
  }

  protected validate(partial: boolean): Record<string, string> {
    this.values();
    this.shape();
    return validateSection('qualifications', this.payload(), this.source().route(), this.today, partial);
  }

  protected payload(): Record<string, unknown> {
    return {
      entries: this.entries.getRawValue().map((e) => ({
        degree: e.degree,
        institution: e.institution,
        year_awarded: e.year_awarded,
      })),
    };
  }

  protected fieldOrder(): string[] {
    return this.entries.controls.flatMap((_, i) => [
      this.entryKey(i, 'degree'),
      this.entryKey(i, 'institution'),
      this.entryKey(i, 'year_awarded'),
    ]);
  }

  protected override idOf(key: string): string {
    return `onb-${key.replace(/\./g, '-')}`;
  }
}
