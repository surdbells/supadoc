import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import { IconComponent } from '@supadoc/ui';

const FIELD =
  'w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20';

/** The signed-in doctor's account + editable public profile (route `/profile`). */
@Component({
  selector: 'doc-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">My Profile</h1>
        <p class="font-sans text-body text-slate">Manage your public profile and account.</p>
      </header>

      <section class="flex items-center gap-4 rounded-card border border-cloud bg-white p-6">
        <span class="flex size-16 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 font-semibold text-cerulean">
          {{ initials() || 'DR' }}
        </span>
        <div class="flex min-w-0 flex-col gap-1">
          <p class="font-heading text-h5 text-ink">{{ name() || 'Doctor' }}</p>
          <p class="truncate font-sans text-body-sm text-slate">{{ loginEmail() }}</p>
          <p class="font-sans text-caption text-slate">{{ specialty() }}</p>
        </div>
      </section>

      <!-- Editable public profile -->
      <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
        <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean">
          <sd-icon name="user" [size]="20" />Public profile
        </h2>

        @if (loading()) {
          <div class="sd-shimmer h-40 rounded-field"></div>
        } @else if (loadError()) {
          <p class="font-sans text-body-sm text-slate">{{ loadError() }}</p>
        } @else {
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Contact email</span>
              <input type="email" class="${FIELD}" [value]="email()" (input)="email.set($any($event.target).value)" placeholder="you@example.com" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Location</span>
              <input class="${FIELD}" [value]="location()" (input)="location.set($any($event.target).value)" placeholder="Lagos, NG" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Languages</span>
              <input class="${FIELD}" [value]="languages()" (input)="languages.set($any($event.target).value)" placeholder="English, French" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Years of experience</span>
              <input type="number" min="0" class="${FIELD}" [value]="years()" (input)="years.set($any($event.target).value)" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Gender</span>
              <select class="${FIELD}" [value]="gender()" (change)="gender.set($any($event.target).value)">
                <option value="">Prefer not to say</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Photo URL</span>
              <input type="url" class="${FIELD}" [value]="photoUrl()" (input)="photoUrl.set($any($event.target).value)" placeholder="https://… or /uploads/…" />
            </label>
          </div>

          <div class="flex flex-wrap items-center gap-6">
            <label class="flex cursor-pointer items-center gap-2">
              <input type="checkbox" class="size-4 accent-cerulean" [checked]="available()" (change)="available.set($any($event.target).checked)" />
              <span class="font-sans text-body-sm text-ink">Available for booking</span>
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input type="checkbox" class="size-4 accent-cerulean" [checked]="offersInPerson()" (change)="offersInPerson.set($any($event.target).checked)" />
              <span class="font-sans text-body-sm text-ink">Offer in-person visits</span>
            </label>
          </div>

          @if (profileNotice()) {
            <p class="rounded-field px-4 py-2 font-label text-caption" [class]="profileOk() ? 'bg-sage/10 text-sage' : 'bg-alert/10 text-alert'">{{ profileNotice() }}</p>
          }
          <button type="button" class="flex w-fit items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="savingProfile()" (click)="saveProfile()">
            <sd-icon name="check" [size]="18" />{{ savingProfile() ? 'Saving…' : 'Save profile' }}
          </button>
          <p class="font-sans text-caption text-slate">
            Your name, specialty, consultation fee and verified status are managed by the back office.
          </p>
        }
      </section>

      <!-- Change password -->
      <section class="flex max-w-md flex-col gap-4 rounded-card border border-cloud bg-white p-6">
        <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean">
          <sd-icon name="lock" [size]="20" />Change password
        </h2>
        <label class="flex flex-col gap-1.5">
          <span class="font-sans text-caption font-semibold text-slate">Current password</span>
          <input type="password" autocomplete="current-password" class="${FIELD}" [value]="currentPw()" (input)="currentPw.set($any($event.target).value)" />
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="font-sans text-caption font-semibold text-slate">New password</span>
          <input type="password" autocomplete="new-password" class="${FIELD}" [value]="newPw()" (input)="newPw.set($any($event.target).value)" placeholder="At least 8 characters" />
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="font-sans text-caption font-semibold text-slate">Confirm new password</span>
          <input type="password" autocomplete="new-password" class="${FIELD}" [value]="confirmPw()" (input)="confirmPw.set($any($event.target).value)" />
        </label>
        @if (pwNotice()) {
          <p class="rounded-field px-4 py-2 font-label text-caption" [class]="pwOk() ? 'bg-sage/10 text-sage' : 'bg-alert/10 text-alert'">{{ pwNotice() }}</p>
        }
        <button type="button" class="flex w-fit items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="savingPw()" (click)="changePassword()">
          {{ savingPw() ? 'Updating…' : 'Update password' }}
        </button>
      </section>
    </div>
  `,
})
export class DoctorProfile implements OnInit {
  private readonly auth = inject(StaffAuthService);
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly name = computed(() => this.auth.displayName());
  protected readonly loginEmail = computed(() => this.auth.user()?.email ?? '');

  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly specialty = signal('');

  // Profile form
  protected readonly email = signal('');
  protected readonly location = signal('');
  protected readonly languages = signal('');
  protected readonly years = signal('');
  protected readonly gender = signal('');
  protected readonly photoUrl = signal('');
  protected readonly available = signal(true);
  protected readonly offersInPerson = signal(false);
  protected readonly savingProfile = signal(false);
  protected readonly profileNotice = signal('');
  protected readonly profileOk = signal(false);

  // Password form
  protected readonly currentPw = signal('');
  protected readonly newPw = signal('');
  protected readonly confirmPw = signal('');
  protected readonly savingPw = signal(false);
  protected readonly pwNotice = signal('');
  protected readonly pwOk = signal(false);

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

  ngOnInit(): void {
    this.api
      .getProfile()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const p = res.data;
          this.specialty.set(p.specialty ?? '');
          this.email.set(p.email ?? '');
          this.location.set(p.location ?? '');
          this.languages.set(p.languages ?? '');
          this.years.set(p.years_experience != null ? String(p.years_experience) : '');
          this.gender.set(p.gender ?? '');
          this.photoUrl.set(p.photo_url ?? '');
          this.available.set(!!p.available);
          this.offersInPerson.set(!!p.offers_in_person);
          this.loading.set(false);
        },
        error: () => {
          this.loadError.set('Could not load your profile.');
          this.loading.set(false);
        },
      });
  }

  protected saveProfile(): void {
    this.savingProfile.set(true);
    this.profileNotice.set('');
    this.api
      .updateProfile({
        email: this.email().trim(),
        location: this.location().trim(),
        languages: this.languages().trim(),
        years_experience: this.years().trim() === '' ? null : this.years().trim(),
        gender: this.gender() as 'male' | 'female' | '',
        photo_url: this.photoUrl().trim(),
        available: this.available(),
        offers_in_person: this.offersInPerson(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.profileOk.set(true);
          this.profileNotice.set('Profile updated.');
          this.savingProfile.set(false);
        },
        error: (err) => {
          this.profileOk.set(false);
          this.profileNotice.set(apiErrorMessage(err, 'Could not save your profile.'));
          this.savingProfile.set(false);
        },
      });
  }

  protected async changePassword(): Promise<void> {
    this.pwNotice.set('');
    if (this.newPw().length < 8) {
      this.pwOk.set(false);
      this.pwNotice.set('New password must be at least 8 characters.');
      return;
    }
    if (this.newPw() !== this.confirmPw()) {
      this.pwOk.set(false);
      this.pwNotice.set('New passwords do not match.');
      return;
    }
    this.savingPw.set(true);
    try {
      await this.auth.changePassword(this.currentPw(), this.newPw());
      this.pwOk.set(true);
      this.pwNotice.set('Password updated.');
      this.currentPw.set('');
      this.newPw.set('');
      this.confirmPw.set('');
    } catch (err) {
      this.pwOk.set(false);
      this.pwNotice.set(apiErrorMessage(err, 'Could not update your password.'));
    } finally {
      this.savingPw.set(false);
    }
  }
}
