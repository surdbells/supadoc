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
import {
  AbstractControl,
  FormArray,
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { DoctorProfileDto } from '@supadoc/models';
import {
  ButtonComponent,
  DoctorProfileCardComponent,
  IconComponent,
  InputComponent,
  type PublicDoctorProfileData,
  SearchSelectComponent,
} from '@supadoc/ui';

/** Date must be a valid, non-future day. */
function pastDateValidator(c: AbstractControl): ValidationErrors | null {
  const v = c.value as string;
  if (!v) return null;
  const d = new Date(`${v}T00:00:00`);
  if (isNaN(d.getTime())) return { invalid: true };
  return d > new Date() ? { future: true } : null;
}

const ROW_INPUT =
  'w-full rounded-field border border-[#b8c6d4] bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20';

/**
 * The signed-in doctor's profile (route `/profile`): a read view, an edit form,
 * a public-profile preview popup and a success toast — all in one component,
 * toggled by the `view` signal (mirrors the patient My Profile pattern).
 */
@Component({
  selector: 'doc-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    ButtonComponent,
    DoctorProfileCardComponent,
    IconComponent,
    InputComponent,
    SearchSelectComponent,
  ],
  host: { class: 'block' },
  template: `
    @if (toast()) {
      <div class="sd-toast-in fixed left-1/2 top-6 z-[70] flex w-[min(680px,92vw)] -translate-x-1/2 items-center justify-center gap-2.5 rounded-card bg-sage px-6 py-3.5 shadow-[0_8px_30px_rgba(16,127,101,0.25)]" role="status">
        <sd-icon name="circle-check" [size]="20" class="text-white" />
        <span class="font-sans text-body font-semibold text-white">{{ toast() }}</span>
      </div>
    }

    <div class="flex flex-col gap-6 py-2">
      @if (loading()) {
        <div class="sd-shimmer h-40 rounded-card"></div>
        <div class="grid gap-6 lg:grid-cols-2">
          <div class="sd-shimmer h-72 rounded-card"></div>
          <div class="sd-shimmer h-72 rounded-card"></div>
        </div>
      } @else if (loadError()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ loadError() }}</p>
        </div>
      } @else {
        @switch (view()) {
          @case ('view') {
            <header class="flex flex-col gap-1">
              <h1 class="font-heading text-h3 text-ink">My Profile</h1>
              <p class="font-sans text-body text-slate">Manage your personal information and account details.</p>
            </header>

            <div class="grid gap-6 lg:grid-cols-2">
              <div class="flex flex-col gap-6">
                <!-- Profile summary -->
                <section class="flex flex-col gap-5 rounded-card border border-cloud bg-white p-6">
                  <div class="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                    <span class="shrink-0">
                      @if (photoSrc()) {
                        <img [src]="photoSrc()" alt="" width="96" height="96" class="size-24 rounded-full object-cover" />
                      } @else {
                        <span class="flex size-24 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h3 text-cerulean">{{ initials() || 'DR' }}</span>
                      }
                    </span>
                    <div class="flex min-w-0 flex-1 flex-col gap-2 text-center sm:text-left">
                      <div class="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                        <h2 class="font-heading text-h4 text-ink">{{ profile()?.name }}</h2>
                        @if (profile()?.verified) {
                          <span class="flex items-center gap-1 rounded-pill border border-cerulean/30 bg-frost px-2.5 py-1 font-sans text-caption font-semibold text-cerulean">
                            <sd-icon name="circle-check" [size]="14" />Verified
                          </span>
                        }
                      </div>
                      <p class="font-sans text-body font-semibold text-cerulean">{{ profile()?.specialty }}</p>
                      <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-sans text-caption text-slate sm:justify-start">
                        <span class="flex items-center gap-1"><sd-icon name="star" [size]="15" class="text-warning" /> {{ profile()?.rating }} ({{ profile()?.reviews_count }} reviews)</span>
                        @if (profile()?.years_experience) {
                          <span class="flex items-center gap-1"><sd-icon name="briefcase" [size]="15" /> {{ profile()?.years_experience }} year experience</span>
                        }
                        @if (locationText()) {
                          <span class="flex items-center gap-1"><sd-icon name="map-pin" [size]="15" /> {{ locationText() }}</span>
                        }
                      </div>
                    </div>
                  </div>
                  <div class="flex flex-col gap-3 sm:flex-row">
                    <sd-button variant="outline" [full]="true" (click)="publicOpen.set(true)">
                      <sd-icon name="user" [size]="18" />View Public Profile
                    </sd-button>
                    <sd-button [full]="true" (click)="startEdit()">
                      <sd-icon name="pencil" [size]="18" />Edit Profile
                    </sd-button>
                  </div>
                </section>

                <!-- Personal Information -->
                <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
                  <h3 class="flex items-center gap-2 font-heading text-body-lg text-ink">
                    <sd-icon name="user" [size]="20" class="text-cerulean" />Personal Information
                  </h3>
                  <dl class="flex flex-col divide-y divide-cloud">
                    <div class="flex items-center justify-between gap-4 py-3"><dt class="font-sans text-caption text-slate">Full name</dt><dd class="text-right font-sans text-body-sm text-ink">{{ profile()?.name }}</dd></div>
                    <div class="flex items-center justify-between gap-4 py-3"><dt class="font-sans text-caption text-slate">Email address</dt><dd class="text-right font-sans text-body-sm text-ink">{{ profile()?.email || '—' }}</dd></div>
                    <div class="flex items-center justify-between gap-4 py-3"><dt class="font-sans text-caption text-slate">Phone number</dt><dd class="text-right font-sans text-body-sm text-ink">{{ profile()?.phone || '—' }}</dd></div>
                    <div class="flex items-center justify-between gap-4 py-3"><dt class="font-sans text-caption text-slate">Date of birth</dt><dd class="text-right font-sans text-body-sm text-ink">{{ profile()?.date_of_birth || '—' }}</dd></div>
                    <div class="flex items-center justify-between gap-4 py-3"><dt class="font-sans text-caption text-slate">Gender</dt><dd class="text-right font-sans text-body-sm capitalize text-ink">{{ profile()?.gender || '—' }}</dd></div>
                    <div class="flex items-center justify-between gap-4 py-3"><dt class="font-sans text-caption text-slate">Country / Location</dt><dd class="text-right font-sans text-body-sm text-ink">{{ locationText() || '—' }}</dd></div>
                  </dl>
                </section>
              </div>

              <!-- Professional Information -->
              <section class="flex h-fit flex-col gap-5 rounded-card border border-cloud bg-white p-6">
                <h3 class="flex items-center gap-2 font-heading text-body-lg text-ink">
                  <sd-icon name="briefcase" [size]="20" class="text-cerulean" />Professional Information
                </h3>
                <div class="flex flex-col gap-1 border-b border-cloud pb-4">
                  <span class="font-sans text-caption text-slate">Medical Speciality</span>
                  <span class="font-sans text-body-sm font-medium text-ink">{{ profile()?.specialty }}</span>
                </div>
                <div class="flex flex-col gap-1 border-b border-cloud pb-4">
                  <span class="font-sans text-caption text-slate">Years of experience</span>
                  <span class="font-sans text-body-sm font-medium text-ink">{{ profile()?.years_experience ?? '—' }} {{ profile()?.years_experience ? 'years' : '' }}</span>
                </div>
                @if (expertise().length) {
                  <div class="flex flex-col gap-2 border-b border-cloud pb-4">
                    <span class="font-sans text-caption text-slate">Area of Expertise</span>
                    <div class="flex flex-wrap gap-2">
                      @for (x of expertise(); track x) { <span class="rounded-pill bg-frost px-3 py-1 font-sans text-caption font-medium text-cerulean">{{ x }}</span> }
                    </div>
                  </div>
                }
                @if (profile()?.bio) {
                  <div class="flex flex-col gap-1 border-b border-cloud pb-4">
                    <span class="font-sans text-caption text-slate">Professional biography</span>
                    <p class="font-sans text-body-sm leading-relaxed text-ink">{{ profile()?.bio }}</p>
                  </div>
                }
                @if (qualificationRows.length) {
                  <div class="flex flex-col gap-2 border-b border-cloud pb-4">
                    <span class="font-sans text-caption text-slate">Qualifications</span>
                    @for (q of qualificationRows.controls; track $index) {
                      <span class="font-sans text-body-sm text-ink">{{ qualLine(q) }}</span>
                    }
                  </div>
                }
                @if (certificationRows.length) {
                  <div class="flex flex-col gap-2 border-b border-cloud pb-4">
                    <span class="font-sans text-caption text-slate">Certifications</span>
                    @for (c of certificationRows.controls; track $index) {
                      <span class="font-sans text-body-sm text-ink">{{ certLine(c) }}</span>
                    }
                  </div>
                }
                @if (languages().length) {
                  <div class="flex flex-col gap-2">
                    <span class="font-sans text-caption text-slate">Languages</span>
                    <div class="flex flex-wrap gap-2">
                      @for (l of languages(); track l) { <span class="rounded-pill bg-glacier px-3 py-1 font-sans text-caption font-medium text-ink">{{ l }}</span> }
                    </div>
                  </div>
                }
              </section>
            </div>
          }

          @case ('edit') {
            <header class="flex items-start justify-between gap-4">
              <h1 class="font-heading text-h3 text-ink">Edit Profile</h1>
              <button type="button" class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean" (click)="cancelEdit()">
                <sd-icon name="chevron-right" [size]="18" class="rotate-180" />Back
              </button>
            </header>

            <!-- Photo -->
            <section class="flex flex-col items-center gap-4 rounded-card border border-cloud bg-white p-6 sm:flex-row">
              <div class="relative shrink-0">
                @if (photoSrc()) {
                  <img [src]="photoSrc()" alt="" width="96" height="96" class="size-24 rounded-full object-cover" />
                } @else {
                  <span class="flex size-24 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h3 text-cerulean">{{ initials() || 'DR' }}</span>
                }
                <button type="button" class="absolute bottom-0 right-0 flex size-9 items-center justify-center rounded-full bg-cerulean text-white ring-2 ring-white transition-opacity disabled:opacity-60" [disabled]="uploadingAvatar()" aria-label="Change photo" (click)="avatarModalOpen.set(true)">
                  @if (uploadingAvatar()) {
                    <span class="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white"></span>
                  } @else { <sd-icon name="camera" [size]="16" /> }
                </button>
              </div>
              <div class="flex flex-col items-center gap-3 sm:flex-row">
                <button type="button" class="font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean" (click)="avatarModalOpen.set(true)">Replace photo</button>
                @if (photoSrc()) {
                  <button type="button" class="flex items-center gap-1.5 rounded-field border border-alert/40 px-4 py-2 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5 disabled:opacity-60" [disabled]="uploadingAvatar()" (click)="deletePhoto()">
                    <sd-icon name="trash-2" [size]="16" />Delete photo
                  </button>
                }
              </div>
            </section>

            <form class="grid gap-6 lg:grid-cols-2" [formGroup]="form" (ngSubmit)="save()">
              <!-- Personal -->
              <section class="flex h-fit flex-col gap-5 rounded-card border border-cloud bg-white p-6">
                <h3 class="flex items-center gap-2 font-heading text-body-lg text-ink"><sd-icon name="user" [size]="20" class="text-cerulean" />Personal Information</h3>
                <sd-input label="Full name" [required]="true" formControlName="name" [error]="fieldError('name')" />
                <sd-input label="Email address" type="email" formControlName="email" [error]="fieldError('email')" />
                <sd-input label="Phone number" type="tel" formControlName="phone" />
                <sd-input label="Date of birth" type="date" formControlName="dob" [max]="today" [error]="dobError()" />
                <div class="flex w-full flex-col gap-2">
                  <span class="font-sans text-body font-semibold text-ink">Gender</span>
                  <sd-search-select size="lg" placeholder="Select" [options]="genderOptions" [value]="form.controls.gender.value" (valueChange)="form.controls.gender.setValue($event)" />
                </div>
                <sd-input label="Country / Location" formControlName="country" />
              </section>

              <!-- Professional -->
              <section class="flex flex-col gap-5 rounded-card border border-cloud bg-white p-6">
                <h3 class="flex items-center gap-2 font-heading text-body-lg text-ink"><sd-icon name="briefcase" [size]="20" class="text-cerulean" />Professional Information</h3>
                <sd-input label="Medical Speciality" [required]="true" formControlName="specialty" [error]="fieldError('specialty')" />
                <sd-input label="Years of experience" type="number" formControlName="years" />

                <!-- Area of expertise (chips) -->
                <div class="flex w-full flex-col gap-2">
                  <span class="font-sans text-body font-semibold text-ink">Area of Expertise</span>
                  @if (expertise().length) {
                    <div class="flex flex-wrap gap-2">
                      @for (x of expertise(); track x; let i = $index) {
                        <span class="flex items-center gap-1 rounded-pill bg-frost px-3 py-1 font-sans text-caption font-medium text-cerulean">
                          {{ x }}
                          <button type="button" class="text-cerulean/70 transition-colors hover:text-alert" aria-label="Remove" (click)="removeExpertise(i)"><sd-icon name="x" [size]="14" /></button>
                        </span>
                      }
                    </div>
                  }
                  <input class="${ROW_INPUT}" placeholder="Add an area, press enter" [value]="expertiseDraft()" (input)="expertiseDraft.set($any($event.target).value)" (keydown.enter)="addExpertise($event)" />
                </div>

                <label class="flex w-full flex-col gap-2">
                  <span class="font-sans text-body font-semibold text-ink">Professional biography</span>
                  <textarea rows="4" class="${ROW_INPUT}" formControlName="bio"></textarea>
                </label>

                <!-- Languages (chips) -->
                <div class="flex w-full flex-col gap-2">
                  <span class="font-sans text-body font-semibold text-ink">Languages</span>
                  @if (languages().length) {
                    <div class="flex flex-wrap gap-2">
                      @for (l of languages(); track l; let i = $index) {
                        <span class="flex items-center gap-1 rounded-pill bg-glacier px-3 py-1 font-sans text-caption font-medium text-ink">
                          {{ l }}
                          <button type="button" class="text-slate transition-colors hover:text-alert" aria-label="Remove" (click)="removeLanguage(i)"><sd-icon name="x" [size]="14" /></button>
                        </span>
                      }
                    </div>
                  }
                  <input class="${ROW_INPUT}" placeholder="Add a language, press enter" [value]="languageDraft()" (input)="languageDraft.set($any($event.target).value)" (keydown.enter)="addLanguage($event)" />
                </div>

                <!-- Qualifications -->
                <div class="flex w-full flex-col gap-3" formArrayName="qualifications">
                  <div class="flex items-center justify-between">
                    <span class="font-sans text-body font-semibold text-ink">Qualifications</span>
                    <button type="button" class="flex items-center gap-1 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean" (click)="addQualification()"><sd-icon name="plus" [size]="16" />Add qualification</button>
                  </div>
                  @for (row of qualificationRows.controls; track $index) {
                    <div [formGroupName]="$index" class="flex flex-col gap-3 rounded-card border border-cloud p-4">
                      <div class="flex items-center justify-between">
                        <span class="font-sans text-caption font-semibold text-slate">Entry {{ $index + 1 }}</span>
                        <button type="button" class="text-alert transition-colors hover:text-alert/70" aria-label="Remove" (click)="removeRow(qualificationRows, $index)"><sd-icon name="trash-2" [size]="16" /></button>
                      </div>
                      <input class="${ROW_INPUT}" placeholder="Degree / title (e.g. MD, Cardiology)" formControlName="title" />
                      <input class="${ROW_INPUT}" placeholder="Institution" formControlName="institution" />
                      <input class="${ROW_INPUT}" placeholder="Year" formControlName="year" />
                    </div>
                  }
                </div>

                <!-- Certifications -->
                <div class="flex w-full flex-col gap-3" formArrayName="certifications">
                  <div class="flex items-center justify-between">
                    <span class="font-sans text-body font-semibold text-ink">Certifications</span>
                    <button type="button" class="flex items-center gap-1 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean" (click)="addCertification()"><sd-icon name="plus" [size]="16" />Add certification</button>
                  </div>
                  @for (row of certificationRows.controls; track $index) {
                    <div [formGroupName]="$index" class="flex flex-col gap-3 rounded-card border border-cloud p-4">
                      <div class="flex items-center justify-between">
                        <span class="font-sans text-caption font-semibold text-slate">Entry {{ $index + 1 }}</span>
                        <button type="button" class="text-alert transition-colors hover:text-alert/70" aria-label="Remove" (click)="removeRow(certificationRows, $index)"><sd-icon name="trash-2" [size]="16" /></button>
                      </div>
                      <input class="${ROW_INPUT}" placeholder="Certification name" formControlName="name" />
                      <input class="${ROW_INPUT}" placeholder="Issuing body" formControlName="body" />
                      <input class="${ROW_INPUT}" placeholder="Year" formControlName="year" />
                    </div>
                  }
                </div>
              </section>

              @if (saveError()) {
                <p class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert lg:col-span-2">{{ saveError() }}</p>
              }
              <div class="flex justify-end gap-3 lg:col-span-2">
                <sd-button variant="outline" type="button" (click)="cancelEdit()">Cancel</sd-button>
                <sd-button type="submit" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save changes' }}</sd-button>
              </div>
            </form>
          }
        }
      }
    </div>

    <!-- Avatar upload modal -->
    @if (avatarModalOpen()) {
      <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="avatarModalOpen.set(false)"></button>
        <div class="relative z-10 flex w-full max-w-md flex-col gap-5 rounded-[16px] bg-white p-6 shadow-[0_8px_40px_rgba(10,22,40,0.2)]">
          <div class="flex items-start justify-between">
            <div class="flex flex-col gap-1">
              <h3 class="font-heading text-h5 text-ink">Update profile photo</h3>
              <p class="font-sans text-body-sm text-slate">Drag an image here, or choose a file.</p>
            </div>
            <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="avatarModalOpen.set(false)"><sd-icon name="x" [size]="22" /></button>
          </div>
          <div class="flex flex-col items-center gap-3 rounded-card border-2 border-dashed px-6 py-10 text-center transition-colors" [class]="avatarDragging() ? 'border-cerulean bg-frost/40' : 'border-cloud bg-glacier/40'"
            (dragover)="$event.preventDefault(); avatarDragging.set(true)" (dragleave)="avatarDragging.set(false)" (drop)="onAvatarDrop($event)">
            @if (uploadingAvatar()) {
              <span class="size-7 animate-spin rounded-full border-2 border-cloud border-t-cerulean"></span>
              <span class="font-sans text-body-sm text-slate">Uploading…</span>
            } @else {
              <span class="flex size-12 items-center justify-center rounded-full bg-frost text-cerulean"><sd-icon name="upload" [size]="24" /></span>
              <p class="font-sans text-body font-semibold text-ink">Drag &amp; drop your photo</p>
              <p class="font-sans text-caption text-slate">PNG, JPG, WEBP or GIF · up to 2MB</p>
              <button type="button" class="mt-1 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="avatarInput.click()">Choose from file</button>
            }
          </div>
          <input #avatarInput type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="hidden" (change)="onAvatarSelected($event)" />
        </div>
      </div>
    }

    <!-- Public profile popup -->
    @if (publicOpen()) {
      <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="publicOpen.set(false)"></button>
        <div class="relative z-10 flex max-h-[88vh] w-full max-w-3xl flex-col overflow-y-auto rounded-[20px] border border-[#cfe6fb] bg-white p-6 shadow-[0_8px_40px_rgba(10,22,40,0.2)] sm:p-8">
          <button type="button" class="absolute right-5 top-5 z-10 text-slate transition-colors hover:text-ink" aria-label="Close" (click)="publicOpen.set(false)"><sd-icon name="x" [size]="22" /></button>
          <sd-doctor-profile-card [data]="publicData()" [photoUrl]="photoSrc()" />
        </div>
      </div>
    }
  `,
})
export class DoctorProfile implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(DoctorApi);
  private readonly auth = inject(StaffAuthService);
  private readonly destroyRef = inject(DestroyRef);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly view = signal<'view' | 'edit'>('view');
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  protected readonly toast = signal('');

  protected readonly profile = signal<DoctorProfileDto | null>(null);
  protected readonly photoPath = signal<string | null>(null);
  protected readonly photoSrc = computed(() => this.api.assetUrl(this.photoPath()));
  protected readonly uploadingAvatar = signal(false);
  protected readonly avatarModalOpen = signal(false);
  protected readonly avatarDragging = signal(false);
  protected readonly publicOpen = signal(false);

  protected readonly expertise = signal<string[]>([]);
  protected readonly expertiseDraft = signal('');
  protected readonly languages = signal<string[]>([]);
  protected readonly languageDraft = signal('');

  protected readonly today = new Date().toISOString().slice(0, 10);
  protected readonly genderOptions = ['Male', 'Female'];

  protected readonly initials = computed(() =>
    (this.profile()?.name ?? this.auth.displayName())
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase(),
  );

  protected readonly locationText = computed(
    () => this.profile()?.country || this.profile()?.location || '',
  );

  /** The current profile shaped for the shared public-profile card (live preview). */
  protected readonly publicData = computed<PublicDoctorProfileData>(() => {
    const p = this.profile();
    return {
      name: p?.name ?? '',
      specialty: p?.specialty ?? '',
      verified: p?.verified,
      rating: p?.rating,
      reviews_count: p?.reviews_count,
      bio: p?.bio,
      languages: this.languages().join(', '),
      years_experience: p?.years_experience ?? null,
      country: p?.country ?? null,
      location: p?.location ?? null,
      gender: p?.gender ?? null,
      expertise: this.expertise(),
      qualification_entries: this.qualificationRows.controls.map((g) => ({
        title: String(g.get('title')?.value ?? ''),
        institution: String(g.get('institution')?.value ?? ''),
        year: String(g.get('year')?.value ?? ''),
      })),
      certifications: this.certificationRows.controls.map((g) => ({
        name: String(g.get('name')?.value ?? ''),
        body: String(g.get('body')?.value ?? ''),
        year: String(g.get('year')?.value ?? ''),
      })),
    };
  });

  protected readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required]],
    specialty: ['', [Validators.required]],
    email: ['', [Validators.email]],
    phone: [''],
    dob: ['', [pastDateValidator]],
    gender: [''],
    country: [''],
    years: [''],
    bio: [''],
    qualifications: this.fb.array<FormGroup>([]),
    certifications: this.fb.array<FormGroup>([]),
  });

  get qualificationRows(): FormArray<FormGroup> {
    return this.form.get('qualifications') as FormArray<FormGroup>;
  }
  get certificationRows(): FormArray<FormGroup> {
    return this.form.get('certifications') as FormArray<FormGroup>;
  }

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => clearTimeout(this.toastTimer));
    this.api
      .getProfile()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.apply(res.data);
          this.loading.set(false);
        },
        error: () => {
          this.loadError.set('Could not load your profile.');
          this.loading.set(false);
        },
      });
  }

  private apply(p: DoctorProfileDto): void {
    this.profile.set(p);
    this.photoPath.set(p.photo_url ?? null);
    this.expertise.set(p.expertise ?? []);
    this.languages.set(
      (p.languages ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

    this.qualificationRows.clear();
    for (const q of p.qualification_entries ?? []) {
      this.qualificationRows.push(
        this.fb.group({
          title: [q.title ?? ''],
          institution: [q.institution ?? ''],
          year: [q.year ?? ''],
        }),
      );
    }
    this.certificationRows.clear();
    for (const c of p.certifications ?? []) {
      this.certificationRows.push(
        this.fb.group({
          name: [c.name ?? ''],
          body: [c.body ?? ''],
          year: [c.year ?? ''],
        }),
      );
    }

    this.form.patchValue({
      name: p.name ?? '',
      specialty: p.specialty ?? '',
      email: p.email ?? '',
      phone: p.phone ?? '',
      dob: p.date_of_birth ?? '',
      gender: p.gender ? p.gender.charAt(0).toUpperCase() + p.gender.slice(1) : '',
      country: p.country ?? p.location ?? '',
      years: p.years_experience != null ? String(p.years_experience) : '',
      bio: p.bio ?? '',
    });
  }

  protected startEdit(): void {
    const p = this.profile();
    if (p) this.apply(p);
    this.saveError.set('');
    this.view.set('edit');
  }

  protected cancelEdit(): void {
    const p = this.profile();
    if (p) this.apply(p);
    this.view.set('view');
  }

  protected fieldError(name: 'name' | 'specialty' | 'email'): string {
    const c = this.form.controls[name];
    if (!c.errors || (!c.touched && !c.dirty)) return '';
    if (c.errors['required']) return 'This field is required';
    if (c.errors['email']) return 'Enter a valid email address';
    return '';
  }

  protected dobError(): string {
    const c = this.form.controls.dob;
    if (!c.errors || (!c.touched && !c.dirty)) return '';
    if (c.errors['future']) return 'Date of birth cannot be in the future.';
    if (c.errors['invalid']) return 'Enter a valid date.';
    return '';
  }

  // ----- Chips -----
  protected addExpertise(event: Event): void {
    event.preventDefault();
    const v = this.expertiseDraft().trim();
    if (v && !this.expertise().includes(v)) {
      this.expertise.update((list) => [...list, v]);
    }
    this.expertiseDraft.set('');
  }
  protected removeExpertise(i: number): void {
    this.expertise.update((list) => list.filter((_, idx) => idx !== i));
  }
  protected addLanguage(event: Event): void {
    event.preventDefault();
    const v = this.languageDraft().trim();
    if (v && !this.languages().includes(v)) {
      this.languages.update((list) => [...list, v]);
    }
    this.languageDraft.set('');
  }
  protected removeLanguage(i: number): void {
    this.languages.update((list) => list.filter((_, idx) => idx !== i));
  }

  // ----- Repeatable entries -----
  protected addQualification(): void {
    this.qualificationRows.push(
      this.fb.group({ title: [''], institution: [''], year: [''] }),
    );
  }
  protected addCertification(): void {
    this.certificationRows.push(
      this.fb.group({ name: [''], body: [''], year: [''] }),
    );
  }
  protected removeRow(arr: FormArray<FormGroup>, i: number): void {
    arr.removeAt(i);
  }

  protected qualLine(q: AbstractControl): string {
    const g = q.value as { title?: string; institution?: string; year?: string };
    const meta = [g.institution, g.year].filter(Boolean).join(' · ');
    return meta ? `${g.title} — ${meta}` : (g.title ?? '');
  }
  protected qualSub(q: AbstractControl): string {
    const g = q.value as { institution?: string; year?: string };
    return [g.institution, g.year].filter(Boolean).join(' · ');
  }
  protected certLine(c: AbstractControl): string {
    const g = c.value as { name?: string; body?: string; year?: string };
    const meta = [g.body, g.year].filter(Boolean).join(' · ');
    return meta ? `${g.name} — ${meta}` : (g.name ?? '');
  }
  protected certSub(c: AbstractControl): string {
    const g = c.value as { body?: string; year?: string };
    return [g.body, g.year].filter(Boolean).join(' · ');
  }

  // ----- Avatar -----
  protected onAvatarSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void this.processAvatar(file);
  }
  protected onAvatarDrop(event: DragEvent): void {
    event.preventDefault();
    this.avatarDragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void this.processAvatar(file);
  }
  private async processAvatar(file: File): Promise<void> {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
      this.showToast('Use a PNG, JPG, WEBP or GIF image.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      this.showToast('Image must be 2MB or smaller.');
      return;
    }
    this.uploadingAvatar.set(true);
    try {
      const res = await firstValueFrom(this.api.uploadAvatar(file));
      this.profile.set(res.data);
      this.photoPath.set(res.data.photo_url ?? null);
      this.avatarModalOpen.set(false);
      this.showToast('Profile photo updated successfully');
    } catch (err) {
      this.showToast(apiErrorMessage(err, 'Could not upload your photo.'));
    } finally {
      this.uploadingAvatar.set(false);
    }
  }
  protected async deletePhoto(): Promise<void> {
    this.uploadingAvatar.set(true);
    try {
      const res = await firstValueFrom(this.api.removeAvatar());
      this.profile.set(res.data);
      this.photoPath.set(null);
      this.showToast('Profile photo removed');
    } catch (err) {
      this.showToast(apiErrorMessage(err, 'Could not remove your photo.'));
    } finally {
      this.uploadingAvatar.set(false);
    }
  }

  // ----- Save -----
  protected save(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.saving.set(true);
    this.saveError.set('');

    const v = this.form.getRawValue();
    this.api
      .updateProfile({
        name: v.name.trim(),
        specialty: v.specialty.trim(),
        email: v.email.trim(),
        phone: v.phone.trim(),
        date_of_birth: v.dob || null,
        gender: (v.gender.toLowerCase() as 'male' | 'female' | ''),
        // The single "Country / Location" field is authoritative for BOTH columns:
        // the patient directory card and location filter read `location`, so send
        // it too (else edits are invisible to patients and a legacy value lingers).
        country: v.country.trim(),
        location: v.country.trim(),
        years_experience: v.years.trim() === '' ? null : v.years.trim(),
        bio: v.bio.trim(),
        languages: this.languages().join(', '),
        expertise: this.expertise(),
        qualification_entries: this.qualificationRows.controls.map((g) => ({
          title: String(g.get('title')?.value ?? '').trim(),
          institution: String(g.get('institution')?.value ?? '').trim(),
          year: String(g.get('year')?.value ?? '').trim(),
        })),
        certifications: this.certificationRows.controls.map((g) => ({
          name: String(g.get('name')?.value ?? '').trim(),
          body: String(g.get('body')?.value ?? '').trim(),
          year: String(g.get('year')?.value ?? '').trim(),
        })),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.apply(res.data);
          this.saving.set(false);
          this.view.set('view');
          this.showToast('Your Profile has successfully updated');
        },
        error: (err) => {
          this.saving.set(false);
          this.saveError.set(apiErrorMessage(err, 'Could not save your profile.'));
        },
      });
  }

  private showToast(message: string): void {
    this.toast.set(message);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3500);
  }
}
