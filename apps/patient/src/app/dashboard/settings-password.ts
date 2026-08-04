import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonComponent, IconComponent, InputComponent } from '@supadoc/ui';

/** Settings › Change Password (standard pattern; Figma 894:25038). */
@Component({
  selector: 'pat-settings-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    ButtonComponent,
    IconComponent,
    InputComponent,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Change Password</h1>
          <p class="font-sans text-body text-slate">
            Your new password must be different from the current one.
          </p>
        </div>
        <a
          routerLink="/dashboard/settings"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      <form
        class="mx-auto flex w-full max-w-[480px] flex-col gap-6 rounded-card border border-cloud bg-white p-6 shadow-[0_1px_3px_rgba(10,22,40,0.06)]"
        [formGroup]="form"
        (ngSubmit)="save()"
      >
        <sd-input
          label="Current Password"
          type="password"
          [required]="true"
          placeholder="Enter current password"
          autocomplete="current-password"
          formControlName="current"
        />
        <sd-input
          label="Password"
          type="password"
          [required]="true"
          placeholder="Create a new password"
          autocomplete="new-password"
          formControlName="next"
        />
        <sd-input
          label="Confirm Password"
          type="password"
          [required]="true"
          placeholder="Re-enter new password"
          autocomplete="new-password"
          formControlName="confirm"
          [error]="mismatch() ? 'Passwords do not match' : ''"
        />

        @if (saved()) {
          <p
            class="flex items-center gap-2 rounded-field bg-sage/10 px-4 py-3 font-sans text-body-sm text-sage"
          >
            <sd-icon name="circle-check" [size]="18" />
            Your password has been updated.
          </p>
        }

        <sd-button
          type="submit"
          [full]="true"
          [disabled]="form.invalid || mismatch()"
          >Save Changes</sd-button
        >
      </form>
    </div>
  `,
})
export class SettingsPassword {
  private readonly fb = inject(FormBuilder);
  protected readonly saved = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    current: ['', [Validators.required]],
    next: [
      '',
      [
        Validators.required,
        Validators.minLength(8),
        Validators.pattern(/^(?=.*\d)(?=.*[A-Z]).+$/),
      ],
    ],
    confirm: ['', [Validators.required]],
  });

  protected mismatch(): boolean {
    const { next, confirm } = this.form.controls;
    return !!confirm.value && next.value !== confirm.value;
  }

  protected save(): void {
    if (this.form.invalid || this.mismatch()) {
      this.form.markAllAsTouched();
      return;
    }
    // TODO: call the change-password API once available.
    this.form.reset();
    this.saved.set(true);
  }
}
