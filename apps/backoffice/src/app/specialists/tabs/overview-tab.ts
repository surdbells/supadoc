import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { tap, type Subscription } from 'rxjs';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorFields, apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type {
  AdminSpecialistUpdate,
  DoctorInviteResultDto,
  SpecialistDetailDto,
} from '@supadoc/models';
import { AlertComponent, DialogService, IconComponent, SearchSelectComponent, type LeaveCopy } from '@supadoc/ui';
import { labelKey } from '../../reference-data/reference-list';
import { afterDialogCloses, focusIfLost } from '../../shared/after-dialog';
import { PhotoPicker, photoErrorText, photoUploadStep } from '../photo-picker';
import { SearchSelectA11y } from '../select-a11y';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  BTN_GHOST,
  doctorLicenceWording,
  FIELD,
  FIELD_INVALID,
  LABEL,
  loginBadge,
  PILL,
  registrationNumber,
} from '../specialist-ui';
import { isActiveSpecialty, SpecialtyChoices, specialtyField } from '../specialty-choices';
import { FORM_ACTIONS, SECTION, SECTION_SM, SECTION_SUBTITLE, SECTION_TITLE } from '../../shared/layout';

/**
 * The PATCH body with `specialty` — the API takes it while the doctor is
 * still onboarding (an active item of the specialty list; 422 otherwise).
 */
type OverviewPatch = AdminSpecialistUpdate & { specialty?: string };

interface Form {
  /** Editable only until approval (then it changes through the doctor's own request). */
  specialty: string;
  email: string;
  consultation_fee: string;
  available: boolean;
  bio: string;
  location: string;
  country: string;
  languages: string;
  years_experience: string;
  gender: '' | 'male' | 'female';
  offers_in_person: boolean;
  /** Comma-separated. */
  expertise: string;
}

type FormKey = keyof Form;

/** Unchanged? The specialty as the API compares it (case and spacing aside); the rest trimmed. */
function same(k: FormKey, a: Form, b: Form): boolean {
  if (k === 'specialty') return labelKey(a.specialty) === labelKey(b.specialty);
  return String(a[k]).trim() === String(b[k]).trim();
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Leave without saving?" for unsaved profile edits (the doctor page's guard and tab switch). */
export const PROFILE_LEAVE_COPY: LeaveCopy = {
  title: 'Leave without saving the profile?',
  message: "Your edits to this doctor's profile haven't been saved. If you leave now, they'll be lost.",
};

function toForm(d: SpecialistDetailDto): Form {
  const p = d.profile;
  const gender = (p.gender ?? '').toLowerCase();
  return {
    specialty: p.specialty ?? '',
    email: p.email ?? '',
    consultation_fee: String(p.consultation_fee ?? ''),
    available: !!p.available,
    bio: p.bio ?? '',
    location: p.location ?? '',
    country: p.country ?? '',
    languages: p.languages ?? '',
    years_experience: p.years_experience === null || p.years_experience === undefined ? '' : String(p.years_experience),
    gender: gender === 'male' || gender === 'female' ? gender : '',
    offers_in_person: !!p.offers_in_person,
    expertise: (p.expertise ?? []).join(', '),
  };
}

/**
 * The doctor page's Overview tab: the doctor's photo (uploaded, replaced or
 * removed on the spot — JPG / PNG / WebP up to 2 MB, audited), the fields a
 * reviewer may edit (the specialty while the doctor is onboarding — picked
 * from the Reference data list — contact, fee, booking switch, public
 * profile; every change audited before/after), the identity fields that only
 * change through a reviewed request (read-only here), and the doctor's login
 * with invite / resend.
 */
@Component({
  selector: 'bo-specialist-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, AlertComponent, SearchSelectComponent, SearchSelectA11y, PhotoPicker],
  template: `
    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div class="flex min-w-0 flex-col gap-6">
      <!-- Photo: saved on its own, straight away (not part of "Save changes"). -->
      <section #photoSection class="${SECTION}" aria-labelledby="bo-ov-photo-title">
        <div class="flex flex-col gap-1">
          <h2 id="bo-ov-photo-title" class="${SECTION_TITLE}"><sd-icon name="camera" [size]="20" class="text-cerulean" />Profile photo</h2>
          <p class="${SECTION_SUBTITLE}">Shown on the doctor's public profile. A new photo replaces the old one straight away and is recorded in the audit log.</p>
        </div>
        <bo-photo-picker
          [src]="photoPreview() ?? photoSrc()"
          [name]="detail().profile.name"
          [progress]="photoProgress()"
          [error]="photoError()"
          (picked)="uploadPhoto($event)"
          (remove)="removePhoto()"
        />
        <div aria-live="polite">
          @if (photoNotice(); as n) {
            <sd-alert tone="success">{{ n }}</sd-alert>
          }
        </div>
      </section>

      <form class="${SECTION}" novalidate (submit)="$event.preventDefault(); save()" aria-labelledby="bo-ov-edit-title">
        <div class="flex flex-col gap-1">
          <h2 id="bo-ov-edit-title" class="${SECTION_TITLE}"><sd-icon name="user-round" [size]="20" class="text-cerulean" />Profile and booking</h2>
          <p class="${SECTION_SUBTITLE}">Changes are saved to the doctor's public profile straight away and recorded in the audit log.</p>
        </div>

        @if (!locked()) {
          <!-- Specialty: from the Reference data list while the doctor is onboarding. -->
          <div class="flex min-w-0 flex-col gap-1.5">
            <span id="bo-ov-spec-label" class="${LABEL}">Specialty</span>
            @switch (choices.state()) {
              @case ('ready') {
                <sd-search-select
                  boSelectA11y="bo-ov-spec-label"
                  [boSelectDescribedBy]="specialtyDescribedBy()"
                  [options]="specialty().options"
                  [value]="specialty().value"
                  (valueChange)="set('specialty', $event)"
                  [clearable]="false"
                  placeholder="Choose a specialty"
                  searchPlaceholder="Search specialties…"
                  [error]="err('specialty')"
                />
                @if (err('specialty'); as e) { <span id="bo-ov-spec-err" class="sr-only">{{ e }}</span> }
              }
              @case ('loading') {
                <div class="sd-shimmer h-12 rounded-field" aria-hidden="true"></div>
                <span class="sr-only" role="status">Loading the specialty list…</span>
              }
              @default {
                <input type="text" class="${FIELD}" [class]="err('specialty') ? '${FIELD_INVALID}' : ''" aria-labelledby="bo-ov-spec-label" [value]="form().specialty" (input)="set('specialty', $any($event.target).value)" placeholder="Cardiology" [attr.aria-invalid]="err('specialty') ? 'true' : null" [attr.aria-describedby]="specialtyDescribedBy()" />
                @if (err('specialty'); as e) { <span id="bo-ov-spec-err" class="font-sans text-caption text-alert">{{ e }}</span> }
              }
            }
            @if (choices.state() === 'failed') {
              <span id="bo-ov-spec-hint" class="flex flex-wrap items-center gap-x-2 font-sans text-caption text-slate">
                The specialty list could not be loaded.
                <button type="button" class="min-h-11 font-semibold text-cerulean hover:underline" (click)="choices.load()">Try again</button>
              </span>
            } @else if (specialtyNote(); as note) {
              <span id="bo-ov-spec-hint" class="flex items-start gap-1.5 font-sans text-caption text-ink">
                <sd-icon name="info" [size]="14" class="mt-0.5 shrink-0 text-warning" />{{ note }}
              </span>
            } @else {
              <span id="bo-ov-spec-hint" class="font-sans text-caption text-slate">
                The doctor can also set it while onboarding; it locks once they are approved.
                @if (canManageLists()) { The list is kept in <a routerLink="/reference-data" class="font-semibold text-cerulean hover:underline">Reference data</a>. }
              </span>
            }
          </div>
        }

        <div class="grid items-start gap-4 sm:grid-cols-2">
          <label class="flex min-w-0 flex-col gap-1.5">
            <span class="${LABEL}">Contact email</span>
            <input type="email" class="${FIELD}" [class]="err('email') ? '${FIELD_INVALID}' : ''" [value]="form().email" (input)="set('email', $any($event.target).value)" placeholder="doctor@example.com" [attr.aria-invalid]="err('email') ? 'true' : null" [attr.aria-describedby]="err('email') ? 'bo-ov-email-err' : 'bo-ov-email-hint'" />
            @if (err('email'); as e) { <span id="bo-ov-email-err" class="font-sans text-caption text-alert">{{ e }}</span> }
            @else { <span id="bo-ov-email-hint" class="font-sans text-caption text-slate">Where invites go before the doctor has a login. A login's own email changes in Staff &amp; roles.</span> }
          </label>
          <label class="flex min-w-0 flex-col gap-1.5">
            <span class="${LABEL}">Consultation fee (₦)</span>
            <input type="number" min="0" step="500" inputmode="decimal" class="${FIELD}" [class]="err('consultation_fee') ? '${FIELD_INVALID}' : ''" [value]="form().consultation_fee" (input)="set('consultation_fee', $any($event.target).value)" [attr.aria-invalid]="err('consultation_fee') ? 'true' : null" [attr.aria-describedby]="err('consultation_fee') ? 'bo-ov-fee-err' : null" />
            @if (err('consultation_fee'); as e) { <span id="bo-ov-fee-err" class="font-sans text-caption text-alert">{{ e }}</span> }
          </label>
        </div>

        <fieldset class="flex flex-col gap-2">
          <legend class="${LABEL} mb-1">Bookings</legend>
          <label class="flex min-h-11 cursor-pointer items-start gap-3">
            <input type="checkbox" class="mt-0.5 size-5 shrink-0 accent-cerulean" [checked]="form().available" (change)="set('available', $any($event.target).checked)" aria-describedby="bo-ov-available-hint" />
            <span class="flex flex-col">
              <span class="font-sans text-body-sm text-ink">Taking bookings</span>
              <span id="bo-ov-available-hint" class="font-sans text-caption text-slate">A temporary pause: switching it off hides new openings but keeps existing bookings. To stop a doctor practising, suspend them instead.</span>
            </span>
          </label>
          <label class="flex min-h-11 cursor-pointer items-center gap-3">
            <input type="checkbox" class="size-5 shrink-0 accent-cerulean" [checked]="form().offers_in_person" (change)="set('offers_in_person', $any($event.target).checked)" />
            <span class="font-sans text-body-sm text-ink">Also sees patients in person</span>
          </label>
        </fieldset>

        <div class="grid items-start gap-4 sm:grid-cols-2">
          <label class="flex min-w-0 flex-col gap-1.5">
            <span class="${LABEL}">Location</span>
            <input type="text" class="${FIELD}" [class]="err('location') ? '${FIELD_INVALID}' : ''" [value]="form().location" (input)="set('location', $any($event.target).value)" placeholder="Lagos" [attr.aria-invalid]="err('location') ? 'true' : null" />
            @if (err('location'); as e) { <span class="font-sans text-caption text-alert">{{ e }}</span> }
          </label>
          <label class="flex min-w-0 flex-col gap-1.5">
            <span class="${LABEL}">Country</span>
            <input type="text" class="${FIELD}" [class]="err('country') ? '${FIELD_INVALID}' : ''" [value]="form().country" (input)="set('country', $any($event.target).value)" placeholder="Nigeria" [attr.aria-invalid]="err('country') ? 'true' : null" />
            @if (err('country'); as e) { <span class="font-sans text-caption text-alert">{{ e }}</span> }
          </label>
          <label class="flex min-w-0 flex-col gap-1.5">
            <span class="${LABEL}">Languages</span>
            <input type="text" class="${FIELD}" [class]="err('languages') ? '${FIELD_INVALID}' : ''" [value]="form().languages" (input)="set('languages', $any($event.target).value)" placeholder="English, Yoruba" [attr.aria-invalid]="err('languages') ? 'true' : null" />
            @if (err('languages'); as e) { <span class="font-sans text-caption text-alert">{{ e }}</span> }
          </label>
          <label class="flex min-w-0 flex-col gap-1.5">
            <span class="${LABEL}">Years of experience</span>
            <input type="number" min="0" max="80" inputmode="numeric" class="${FIELD}" [class]="err('years_experience') ? '${FIELD_INVALID}' : ''" [value]="form().years_experience" (input)="set('years_experience', $any($event.target).value)" [attr.aria-invalid]="err('years_experience') ? 'true' : null" />
            @if (err('years_experience'); as e) { <span class="font-sans text-caption text-alert">{{ e }}</span> }
          </label>
          <label class="flex min-w-0 flex-col gap-1.5">
            <span class="${LABEL}">Gender</span>
            <select class="${FIELD} min-h-11" (change)="set('gender', $any($event.target).value)">
              <option value="" [selected]="form().gender === ''">Not given</option>
              <option value="female" [selected]="form().gender === 'female'">Female</option>
              <option value="male" [selected]="form().gender === 'male'">Male</option>
            </select>
          </label>
          <label class="flex min-w-0 flex-col gap-1.5">
            <span class="${LABEL}">Areas of expertise</span>
            <input type="text" class="${FIELD}" [value]="form().expertise" (input)="set('expertise', $any($event.target).value)" placeholder="Hypertension, Heart failure" aria-describedby="bo-ov-expertise-hint" />
            <span id="bo-ov-expertise-hint" class="font-sans text-caption text-slate">Separate with commas (up to 30).</span>
          </label>
        </div>

        <label class="flex min-w-0 flex-col gap-1.5">
          <span class="${LABEL}">Bio</span>
          <textarea rows="5" maxlength="5000" class="${FIELD}" [class]="err('bio') ? '${FIELD_INVALID}' : ''" [value]="form().bio" (input)="set('bio', $any($event.target).value)" [attr.aria-invalid]="err('bio') ? 'true' : null"></textarea>
          @if (err('bio'); as e) { <span class="font-sans text-caption text-alert">{{ e }}</span> }
        </label>

        <div aria-live="polite">
          @if (notice(); as n) {
            <sd-alert [tone]="noticeOk() ? 'success' : 'error'">{{ n }}</sd-alert>
          }
        </div>

        <div class="${FORM_ACTIONS} border-t border-cloud pt-5">
          @if (dirty()) {
            <button type="button" class="${BTN_GHOST}" [disabled]="saving()" (click)="discard()"><sd-icon name="undo-2" [size]="18" />Undo changes</button>
          }
          <button type="submit" class="${BTN_PRIMARY}" [disabled]="saving() || !dirty()">
            <sd-icon [name]="saving() ? 'loader-circle' : 'save'" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? 'Saving…' : 'Save changes' }}
          </button>
        </div>
      </form>
      </div>

      <div class="flex min-w-0 flex-col gap-6">
        <!-- Login -->
        <section class="${SECTION_SM}" aria-labelledby="bo-ov-login-title">
          <h2 id="bo-ov-login-title" class="${SECTION_TITLE}"><sd-icon name="user-check" [size]="20" class="text-cerulean" />Login</h2>
          <span class="${PILL} w-fit" [class]="login().cls"><sd-icon [name]="login().icon" [size]="13" />{{ login().label }}</span>
          @if (detail().login; as l) {
            <p class="break-all font-sans text-body-sm text-ink">{{ l.email }}</p>
          }
          @if (canInvite()) {
            @if (inviteHint(); as hint) {
              <p class="font-sans text-caption text-slate">{{ hint }}</p>
            }
            <button type="button" class="${BTN_SECONDARY} w-full sm:w-fit" [disabled]="inviting() || inviteHint() !== ''" (click)="invite()">
              <sd-icon [name]="inviting() ? 'loader-circle' : 'mail'" [size]="16" [class.animate-spin]="inviting()" />{{ inviting() ? 'Sending…' : (detail().login ? 'Resend invite' : 'Send invite') }}
            </button>
          }
          <div aria-live="polite">
            @if (inviteResult(); as r) {
              <div class="flex flex-col gap-1 rounded-field bg-sage/10 px-4 py-3 font-sans text-caption text-ink">
                <span>{{ r.email_sent ? 'Invite sent to ' + (r.login?.email ?? detail().profile.email) + '. The link expires in 7 days.' : 'The invite link was created, but the email could not be sent. Try "Resend invite" shortly.' }}</span>
                @if (r.dev_link) {
                  <span class="break-all text-slate">Testing only — set-password link: <span class="select-all font-mono text-ink">{{ r.dev_link }}</span></span>
                }
              </div>
            }
            @if (inviteError()) {
              <sd-alert tone="error">{{ inviteError() }}</sd-alert>
            }
          </div>
          @if (canManageStaff()) {
            <a routerLink="/staff" class="inline-flex min-h-11 w-fit items-center gap-1 font-sans text-caption font-semibold text-cerulean hover:underline">
              Manage logins in Staff &amp; roles<sd-icon name="chevron-right" [size]="14" />
            </a>
          }
        </section>

        <!-- Identity (reviewed) -->
        <section class="${SECTION_SM}" aria-labelledby="bo-ov-identity-title">
          <h2 id="bo-ov-identity-title" class="${SECTION_TITLE}"><sd-icon name="lock" [size]="20" class="text-cerulean" />Identity</h2>
          <p class="font-sans text-caption text-slate">
            {{ locked() ? 'Locked since approval: the doctor requests changes, and a reviewer approves them on the Review tab.' : 'The doctor fills these in during onboarding.' }}
          </p>
          <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 font-sans text-body-sm">
            <dt class="text-slate">Name</dt><dd class="break-words text-ink">{{ detail().profile.name }}</dd>
            <dt class="text-slate">Specialty</dt>
            <dd class="break-words text-ink">
              {{ detail().profile.specialty }}
              @if (savedSpecialty().currentInactive) {
                <span class="block text-caption text-slate">Switched off in the list — kept until it is changed.</span>
              } @else if (savedSpecialty().currentUnlisted) {
                <span class="block text-caption text-slate">Not on the specialty list — kept until it is changed.</span>
              }
            </dd>
            @if (wording().abroad) {
              <dt class="text-slate">Regulator</dt><dd class="break-words text-ink">{{ wording().regulator }}{{ regulatorCountry() ? ' (' + regulatorCountry() + ')' : '' }}</dd>
              <dt class="text-slate">Registration no.</dt><dd class="break-all text-ink">{{ registration() || '—' }}</dd>
            } @else {
              <dt class="text-slate">MDCN no.</dt><dd class="break-all text-ink">{{ detail().profile.mdcn_number || '—' }}</dd>
            }
            <dt class="text-slate">Phone</dt><dd class="break-all text-ink">{{ detail().profile.phone || '—' }}</dd>
            <dt class="text-slate">Signature</dt><dd class="text-ink">{{ detail().profile.has_signature ? 'Saved' : 'Not saved' }}</dd>
            <dt class="text-slate">Consult length</dt><dd class="text-ink">{{ detail().profile.slot_minutes ? detail().profile.slot_minutes + ' minutes' : '—' }}</dd>
            <dt class="text-slate">Weekly hours</dt><dd class="break-words text-ink">{{ hours() }}</dd>
          </dl>
          @if (detail().pending_changes) {
            <p class="flex items-center gap-1.5 font-sans text-caption text-ink"><sd-icon name="square-pen" [size]="14" class="text-warning" />A change request is waiting on the Review tab.</p>
          }
        </section>
      </div>
    </div>
  `,
})
export class SpecialistOverviewTab {
  private readonly api = inject(SpecialistsApi);
  private readonly auth = inject(StaffAuthService);
  private readonly dialogs = inject(DialogService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly doc = inject(DOCUMENT);
  protected readonly choices = inject(SpecialtyChoices);

  readonly detail = input.required<SpecialistDetailDto>();
  readonly updated = output<Partial<SpecialistDetailDto>>();

  // ----- Photo (uploaded / removed on its own) -----
  /** 0–100 while a photo uploads; null when idle. */
  protected readonly photoProgress = signal<number | null>(null);
  protected readonly photoError = signal('');
  protected readonly photoNotice = signal('');
  /** The picked file, shown while it uploads (an object URL). */
  protected readonly photoPreview = signal<string | null>(null);
  private photoSub?: Subscription;
  private readonly photoSection = viewChild<ElementRef<HTMLElement>>('photoSection');

  /** The specialty dropdown for the value in the form. */
  protected readonly specialty = computed(() => specialtyField(this.choices.items(), this.form().specialty));
  /** …and for the saved value (the Identity card's "switched off" note). */
  protected readonly savedSpecialty = computed(() =>
    this.choices.state() === 'ready'
      ? specialtyField(this.choices.items(), this.detail().profile.specialty)
      : specialtyField([], ''),
  );
  protected readonly specialtyNote = computed(() => {
    if (this.choices.state() !== 'ready') return '';
    const f = this.specialty();
    const v = f.value;
    if (f.currentInactive) return `“${v}” has been switched off in the list. It stays until you choose another.`;
    if (f.currentUnlisted) return `“${v}” isn't on the specialty list. It stays until you choose one from the list.`;
    return '';
  });
  protected readonly specialtyDescribedBy = computed(() =>
    [this.err('specialty') ? 'bo-ov-spec-err' : '', 'bo-ov-spec-hint'].filter(Boolean).join(' '),
  );
  protected readonly canManageLists = computed(() => this.auth.hasPermission('settings.manage'));

  /** The form as last saved (reset whenever the page's data changes). */
  private readonly saved = signal<Form | null>(null);
  protected readonly form = signal<Form>({} as Form);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly saving = signal(false);
  protected readonly notice = signal('');
  protected readonly noticeOk = signal(false);

  protected readonly inviting = signal(false);
  protected readonly inviteError = signal('');
  protected readonly inviteResult = signal<DoctorInviteResultDto | null>(null);

  protected readonly login = computed(() => loginBadge(this.detail().login));
  protected readonly locked = computed(() => (this.detail().locked_fields ?? []).length > 0);
  /** MDCN wording, or the doctor's regulator when licensed abroad (set by the application; no edit path). */
  protected readonly wording = computed(() => doctorLicenceWording(this.detail()));
  protected readonly registration = computed(() => registrationNumber(this.detail()));
  protected readonly regulatorCountry = computed(
    () => this.detail().registration?.regulator_country ?? this.detail().profile.regulator_country ?? null,
  );
  protected readonly canManageStaff = computed(() => this.auth.hasPermission('staff.manage'));
  protected readonly photoSrc = computed(() => this.api.assetUrl(this.detail().profile.photo_url?.trim() || null));

  protected readonly dirty = computed(() => {
    const saved = this.saved();
    if (!saved) return false;
    const now = this.form();
    return (Object.keys(saved) as FormKey[]).some((k) => !same(k, now, saved));
  });

  protected readonly hours = computed(() => {
    const hours = this.detail().profile.weekly_hours ?? {};
    const parts = Object.keys(hours)
      .sort()
      .filter((d) => (hours[d] ?? []).length > 0)
      .map((d) => `${WEEKDAYS[Number(d)] ?? d} ${hours[d].map(([a, b]) => `${a}–${b}`).join(', ')}`);
    if (parts.length) return parts.join(' · ');
    return this.detail().checklist.availability ? 'No weekly hours — uses published open slots.' : 'Not set yet.';
  });

  constructor() {
    // Re-seed the form from the page's data — unless the reviewer has unsaved edits.
    effect(() => {
      const d = this.detail();
      untracked(() => {
        if (this.saved() && this.dirty()) return;
        const f = toForm(d);
        this.saved.set(f);
        this.form.set({ ...f });
      });
    });
    // The specialty list (re-read, so a just-added item shows up).
    this.choices.load();
    this.destroyRef.onDestroy(() => {
      this.photoSub?.unsubscribe();
      this.setPreview(null);
    });
  }

  protected err(key: string): string {
    return this.errors()[key] ?? '';
  }

  protected set<K extends FormKey>(key: K, value: Form[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
    this.notice.set('');
    if (this.errors()[key]) {
      this.errors.update((e) => {
        const next = { ...e };
        delete next[key];
        return next;
      });
    }
  }

  /**
   * For the doctor page's leave guard and tab switch: profile edits that
   * aren't saved yet, or a photo still uploading (leaving destroys this tab,
   * which aborts the upload).
   */
  hasUnsavedChanges(): boolean {
    return this.hasUnsavedEdits() || this.photoProgress() !== null;
  }

  /** The leave prompt's words for what would be lost. */
  leaveCopy(): LeaveCopy {
    const edits = this.hasUnsavedEdits();
    if (this.photoProgress() === null) return PROFILE_LEAVE_COPY;
    if (!edits) {
      return {
        title: 'Leave while the photo uploads?',
        message: "The new photo is still uploading. If you leave now, the upload stops and the photo may not be saved.",
        confirmLabel: 'Stop the upload and leave',
        cancelLabel: 'Stay',
      };
    }
    return {
      title: 'Leave without saving the profile?',
      message:
        "Your edits to this doctor's profile haven't been saved, and the new photo is still uploading. If you leave now, the edits are lost and the photo may not be saved.",
    };
  }

  private hasUnsavedEdits(): boolean {
    return this.dirty() && !this.saving();
  }

  protected async discard(): Promise<void> {
    const saved = this.saved();
    if (!saved) return;
    const { confirmed } = await this.dialogs.confirm({
      tone: 'warning',
      icon: 'undo-2',
      title: 'Discard changes?',
      message: "Your edits to this doctor's profile will be lost.",
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
    });
    if (!confirmed) return;
    this.form.set({ ...saved });
    this.errors.set({});
    this.notice.set('');
  }

  protected save(): void {
    const saved = this.saved();
    if (!saved || this.saving() || !this.dirty()) return;
    const f = this.form();
    const errors: Record<string, string> = {};
    const email = f.email.trim();
    if (email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors['email'] = 'Enter a valid email address.';
    const fee = f.consultation_fee.trim();
    if (fee === '' || isNaN(Number(fee)) || Number(fee) < 0) errors['consultation_fee'] = 'Enter a fee of 0 or more.';
    const years = f.years_experience.trim();
    if (years !== '' && (!Number.isInteger(Number(years)) || Number(years) < 0 || Number(years) > 80)) {
      errors['years_experience'] = 'Enter a whole number of years (0–80).';
    }
    const specialtyChanged = !this.locked() && !same('specialty', f, saved);
    const specialty = f.specialty.trim();
    if (specialtyChanged) {
      if (specialty === '') errors['specialty'] = 'Choose a specialty.';
      else if (this.choices.state() === 'ready' && !isActiveSpecialty(this.choices.items(), specialty)) {
        errors['specialty'] = 'Choose a specialty from the list.';
      }
    }
    this.errors.set(errors);
    if (Object.keys(errors).length > 0) {
      this.noticeOk.set(false);
      this.notice.set('Please fix the highlighted fields, then save again.');
      return;
    }

    // Send only what changed, so the audit records exactly that. (The photo
    // has its own upload / remove; `photo_url` is never sent from here.)
    const patch: OverviewPatch = {};
    const changed = (k: FormKey) => !same(k, f, saved);
    if (specialtyChanged) patch.specialty = specialty;
    if (changed('email')) patch.email = email;
    if (changed('consultation_fee')) patch.consultation_fee = fee;
    if (changed('available')) patch.available = f.available;
    if (changed('bio')) patch.bio = f.bio.trim();
    if (changed('location')) patch.location = f.location.trim();
    if (changed('country')) patch.country = f.country.trim();
    if (changed('languages')) patch.languages = f.languages.trim();
    if (changed('years_experience')) patch.years_experience = years === '' ? null : Number(years);
    if (changed('gender')) patch.gender = f.gender;
    if (changed('offers_in_person')) patch.offers_in_person = f.offers_in_person;
    if (changed('expertise')) {
      patch.expertise = f.expertise
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 30);
    }

    this.saving.set(true);
    this.notice.set('');
    this.api
      .update(this.detail().profile.id, patch)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          this.noticeOk.set(true);
          this.notice.set('Saved.');
          const d = res.data;
          // Let the effect re-seed the form from what the server saved.
          this.saved.set(null);
          this.updated.emit({ profile: { ...this.detail().profile, ...d } });
        },
        error: (err: unknown) => {
          this.saving.set(false);
          this.errors.set(apiErrorFields(err));
          this.noticeOk.set(false);
          this.notice.set(apiErrorMessage(err, 'Could not save the changes.'));
        },
      });
  }

  // ----- Photo -----

  /** Upload (or replace) the photo straight away — POST /specialists/{id}/photo, audited. */
  protected uploadPhoto(file: File): void {
    if (this.photoProgress() !== null) return;
    const id = this.detail().profile.id;
    this.photoError.set('');
    this.photoNotice.set('');
    this.setPreview(URL.createObjectURL(file));
    this.photoProgress.set(0);
    const hadPhoto = !!this.detail().profile.photo_url;
    this.photoSub = this.api
      .uploadPhoto(id, file)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (event) => {
          const step = photoUploadStep(event);
          if (step.progress !== undefined) this.photoProgress.set(step.progress);
          if (step.result) this.photoSaved(step.result.photo_url ?? null, hadPhoto ? 'Photo replaced.' : 'Photo added.');
        },
        error: (err: unknown) => {
          this.photoProgress.set(null);
          this.setPreview(null);
          this.photoError.set(photoErrorText(err));
        },
        complete: () => {
          this.photoProgress.set(null);
          this.setPreview(null);
        },
      });
  }

  /** "Remove this photo?" — removed inside the dialog (spinner, inline error). */
  protected async removePhoto(): Promise<void> {
    if (this.photoProgress() !== null || !this.detail().profile.photo_url) return;
    const id = this.detail().profile.id;
    this.photoError.set('');
    this.photoNotice.set('');
    const { confirmed } = await this.dialogs.confirm({
      tone: 'danger',
      icon: 'image-off',
      title: 'Remove this photo?',
      message: `${this.detail().profile.name}'s public profile shows their initials until a new photo is added. The removal is recorded in the audit log.`,
      confirmLabel: 'Remove photo',
      cancelLabel: 'Keep it',
      action: () => this.api.removePhoto(id).pipe(tap((res) => this.photoSaved(res.data.photo_url ?? null, 'Photo removed.'))),
      errorMessage: (err) => photoErrorText(err, 'Could not remove the photo.'),
    });
    // "Remove photo" is gone: put focus on the drop zone (the add-a-photo button).
    if (confirmed) {
      afterDialogCloses(() => focusIfLost(this.photoSection()?.nativeElement.querySelector<HTMLElement>('sd-file-drop button'), this.doc), this.doc);
    }
  }

  /** The photo changed on the server: show it now, then re-read the page (its checklist counts the photo). */
  private photoSaved(photoUrl: string | null, notice: string): void {
    const d = this.detail();
    this.photoNotice.set(notice);
    this.updated.emit({ profile: { ...d.profile, photo_url: photoUrl } });
    this.api
      .detail(d.profile.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (res) => this.updated.emit(res.data), error: () => undefined });
  }

  private setPreview(url: string | null): void {
    const old = this.photoPreview();
    if (old) URL.revokeObjectURL(old);
    this.photoPreview.set(url);
  }

  // ----- Login / invite -----

  /** Invite until the doctor has chosen a password (an active login needs none). */
  protected canInvite(): boolean {
    const l = this.detail().login;
    return !l || (l.active && !l.password_set);
  }

  /** Why the invite can't go yet ('' when it can) — the API's own rules. */
  protected inviteHint(): string {
    const d = this.detail();
    if (d.login) return '';
    if (d.status === 'approved' || d.status === 'suspended') {
      return 'This doctor is already live, so their login has to be created from Staff & roles.';
    }
    const savedEmail = (d.profile.email ?? '').trim();
    if (!savedEmail) return "Add the doctor's email, save, then send the invite.";
    if (this.form().email.trim() !== savedEmail) return 'Save the new email before sending the invite.';
    return '';
  }

  protected invite(): void {
    if (this.inviting() || this.inviteHint()) return;
    this.inviting.set(true);
    this.inviteError.set('');
    this.inviteResult.set(null);
    this.api
      .invite(this.detail().profile.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.inviting.set(false);
          this.inviteResult.set(res.data);
          if (res.data.login !== undefined) this.updated.emit({ login: res.data.login ?? null });
        },
        error: (err: unknown) => {
          this.inviting.set(false);
          this.inviteError.set(apiErrorMessage(err, 'Could not send the invite.'));
        },
      });
  }
}
