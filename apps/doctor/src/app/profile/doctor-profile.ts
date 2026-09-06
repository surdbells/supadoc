import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { StaffAuthService } from '@supadoc/auth';
import { IconComponent } from '@supadoc/ui';

/** The signed-in doctor's account overview (route `/profile`). */
@Component({
  selector: 'doc-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">My Profile</h1>
        <p class="font-sans text-body text-slate">Your account details.</p>
      </header>

      <section class="flex items-center gap-4 rounded-card border border-cloud bg-white p-6">
        <span class="flex size-16 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 font-semibold text-cerulean">
          {{ initials() || 'DR' }}
        </span>
        <div class="flex min-w-0 flex-col gap-1">
          <p class="font-heading text-h5 text-ink">{{ name() || 'Doctor' }}</p>
          <p class="truncate font-sans text-body-sm text-slate">{{ email() }}</p>
        </div>
      </section>

      <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
        <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean">
          <sd-icon name="shield-check" [size]="20" />Access
        </h2>
        <div class="flex flex-col gap-2 font-sans text-body-sm text-ink">
          <div class="flex justify-between gap-4">
            <span class="text-slate">Roles</span>
            <span class="text-right">{{ roles() || '—' }}</span>
          </div>
          <div class="flex justify-between gap-4">
            <span class="text-slate">Account</span>
            <span class="text-right">{{ active() ? 'Active' : 'Inactive' }}</span>
          </div>
        </div>
        <p class="flex items-start gap-2 rounded-field bg-glacier px-4 py-3 font-sans text-caption text-slate">
          <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />
          Your public profile, fees and availability are managed by the clinic's
          back office. Contact an administrator to update them.
        </p>
      </section>
    </div>
  `,
})
export class DoctorProfile {
  private readonly auth = inject(StaffAuthService);

  protected readonly name = computed(() => this.auth.displayName());
  protected readonly email = computed(() => this.auth.user()?.email ?? '');
  protected readonly roles = computed(() => this.auth.roles().join(', '));
  protected readonly active = computed(() => this.auth.user()?.active ?? false);
  protected readonly initials = computed(() =>
    this.auth
      .displayName()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase(),
  );
}
