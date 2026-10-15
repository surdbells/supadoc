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
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorFields, apiErrorMessage, DoctorApi, doctorStandingCode, todayLocal } from '@supadoc/data-access';
import type {
  CertificationEntry,
  CredentialType,
  DoctorProfileDto,
  DoctorProfileUpdate,
  DoctorSignatureDto,
  LockedField,
  QualificationEntry,
} from '@supadoc/models';
import {
  AlertComponent,
  ButtonComponent,
  DialogComponent,
  DialogService,
  DoctorProfileCardComponent,
  type LeaveCopy,
  IconComponent,
  InputComponent,
  type PublicDoctorProfileData,
  SearchSelectComponent,
} from '@supadoc/ui';
import { type CredentialChipState, CredentialStatusChip } from '../onboarding/credential-status';
import { SignaturePad } from '../prescriptions/signature-pad';
import { DoctorStandingStore } from '../standing/doctor-standing.store';
import {
  CHANGE_FIELD_LABELS,
  daysUntil,
  inDaysLabel,
  latestCredential,
  licenceDocuments,
  renewalText,
  ymdLabel,
} from '../standing/standing-rules';

/** Date must be a valid, non-future day. */
function pastDateValidator(c: AbstractControl): ValidationErrors | null {
  const v = c.value as string;
  if (!v) return null;
  const d = new Date(`${v}T00:00:00`);
  if (isNaN(d.getTime())) return { invalid: true };
  return d > new Date() ? { future: true } : null;
}

/** MDCN registration number: letters, numbers, / or - (mirrors the API check). */
const MDCN_PATTERN = /^[A-Za-z0-9/ -]{3,40}$/;

/** Signature pictures must be under 500 KB (the API's limit, 512,000 bytes). */
const SIGNATURE_MAX_BYTES = 512_000;

const ROW_INPUT =
  'w-full rounded-field border border-[#b8c6d4] bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20';

/** A verified (locked) value in the edit form: shown, not editable. */
const LOCKED_VALUE =
  'flex items-center gap-2 rounded-field border border-cloud bg-glacier px-4 py-3 font-sans text-body-sm text-ink';
/** "Change pending" next to a verified field with a change waiting for review. */
const PENDING_BADGE =
  'inline-flex items-center gap-1 rounded-pill bg-warning/15 px-2 py-0.5 font-sans text-caption font-semibold text-ink';

/** One requested change, for the "waiting for review" box. */
interface PendingRow {
  readonly label: string;
  readonly value: string;
  readonly current: string;
}

const entriesText = (rows: readonly (QualificationEntry | CertificationEntry)[] | null | undefined): string =>
  (rows ?? [])
    .map((r) => {
      const head = 'title' in r ? r.title : r.name;
      const meta = ['institution' in r ? r.institution : r.body, r.year].filter(Boolean).join(' · ');
      return meta ? `${head} — ${meta}` : head;
    })
    .join('; ');

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
    RouterLink,
    AlertComponent,
    ButtonComponent,
    CredentialStatusChip,
    DialogComponent,
    DoctorProfileCardComponent,
    IconComponent,
    InputComponent,
    SearchSelectComponent,
    SignaturePad,
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

            <!-- A change to the verified details, waiting for a reviewer (or the last one refused). -->
            <div aria-live="polite">
              @if (pending()) {
                <section class="flex flex-col gap-3 rounded-card border border-cerulean/20 bg-frost/50 p-5" aria-labelledby="pending-title">
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="flex min-w-0 flex-col gap-1">
                      <h2 id="pending-title" class="flex items-center gap-2 font-heading text-body-lg text-ink">
                        <sd-icon name="hourglass" [size]="20" class="text-cerulean" />Change request waiting for review
                      </h2>
                      <p class="font-sans text-caption text-slate">
                        {{ profile()?.pending_changes_submitted_at ? 'Sent ' + date(profile()?.pending_changes_submitted_at) + '. ' : '' }}Patients and your prescriptions show your current details until a reviewer approves it.
                      </p>
                    </div>
                    <sd-button variant="outline" size="sm" [disabled]="withdrawing()" (click)="askWithdraw()">
                      <sd-icon name="undo-2" [size]="16" />{{ withdrawing() ? 'Withdrawing…' : 'Withdraw request' }}
                    </sd-button>
                  </div>
                  <dl class="flex flex-col divide-y divide-cloud rounded-field border border-cloud bg-white">
                    @for (row of pendingRows(); track row.label) {
                      <div class="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
                        <dt class="w-36 shrink-0 font-sans text-caption font-semibold text-slate">{{ row.label }}</dt>
                        <dd class="min-w-0 break-words font-sans text-body-sm text-ink">
                          <span class="block">{{ row.value || '—' }}</span>
                          <span class="block font-sans text-caption text-slate">Now: {{ row.current || '—' }}</span>
                        </dd>
                      </div>
                    }
                  </dl>
                  @if (withdrawError()) {
                    <sd-alert tone="error">{{ withdrawError() }}</sd-alert>
                  }
                </section>
              } @else if (profile()?.changes_review_note && locked()) {
                <sd-alert tone="warning">
                  <span class="block font-semibold">Your last change request wasn't approved.</span>
                  <span class="block whitespace-pre-line break-words text-ink">{{ profile()?.changes_review_note }}</span>
                </sd-alert>
              }
            </div>

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
                        @if (isPending('name')) { <span class="${PENDING_BADGE}"><sd-icon name="hourglass" [size]="12" />Change pending</span> }
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
                    <div class="flex items-center justify-between gap-4 py-3">
                      <dt class="flex flex-wrap items-center gap-2 font-sans text-caption text-slate">
                        Full name
                        @if (isPending('name')) { <span class="${PENDING_BADGE}"><sd-icon name="hourglass" [size]="12" />Change pending</span> }
                      </dt>
                      <dd class="text-right font-sans text-body-sm text-ink">{{ profile()?.name }}</dd>
                    </div>
                    <div class="flex items-center justify-between gap-4 py-3"><dt class="font-sans text-caption text-slate">Email address</dt><dd class="text-right font-sans text-body-sm text-ink">{{ profile()?.email || '—' }}</dd></div>
                    <div class="flex items-center justify-between gap-4 py-3"><dt class="font-sans text-caption text-slate">Phone number</dt><dd class="text-right font-sans text-body-sm text-ink">{{ profile()?.phone || '—' }}</dd></div>
                    <div class="flex items-center justify-between gap-4 py-3"><dt class="font-sans text-caption text-slate">Date of birth</dt><dd class="text-right font-sans text-body-sm text-ink">{{ profile()?.date_of_birth || '—' }}</dd></div>
                    <div class="flex items-center justify-between gap-4 py-3"><dt class="font-sans text-caption text-slate">Gender</dt><dd class="text-right font-sans text-body-sm capitalize text-ink">{{ profile()?.gender || '—' }}</dd></div>
                    <div class="flex items-center justify-between gap-4 py-3"><dt class="font-sans text-caption text-slate">Country / Location</dt><dd class="text-right font-sans text-body-sm text-ink">{{ locationText() || '—' }}</dd></div>
                  </dl>
                </section>
              </div>

              <div class="flex flex-col gap-6">
                <!-- Professional Information -->
                <section class="flex h-fit flex-col gap-5 rounded-card border border-cloud bg-white p-6">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <h3 class="flex items-center gap-2 font-heading text-body-lg text-ink">
                      <sd-icon name="briefcase" [size]="20" class="text-cerulean" />Professional Information
                    </h3>
                    @if (locked()) {
                      <sd-button variant="outline" size="sm" (click)="startChanges()">
                        <sd-icon name="square-pen" [size]="16" />{{ pending() ? 'Update request' : 'Request a change' }}
                      </sd-button>
                    }
                  </div>
                  @if (locked()) {
                    <p class="flex items-start gap-2 rounded-field bg-glacier px-3 py-2 font-sans text-caption text-slate">
                      <sd-icon name="lock" [size]="14" class="mt-0.5 shrink-0" />
                      Your name, speciality, MDCN number, qualifications and certifications were verified when you were approved. Changes to them go to a reviewer first.
                    </p>
                  }
                  <div class="flex flex-col gap-1 border-b border-cloud pb-4">
                    <span class="flex flex-wrap items-center gap-2 font-sans text-caption text-slate">
                      Medical Speciality
                      @if (isPending('specialty')) { <span class="${PENDING_BADGE}"><sd-icon name="hourglass" [size]="12" />Change pending</span> }
                    </span>
                    <span class="font-sans text-body-sm font-medium text-ink">{{ profile()?.specialty }}</span>
                  </div>
                  <div class="flex flex-col gap-1 border-b border-cloud pb-4">
                    <span class="flex flex-wrap items-center gap-2 font-sans text-caption text-slate">
                      MDCN registration number
                      @if (isPending('mdcn_number')) { <span class="${PENDING_BADGE}"><sd-icon name="hourglass" [size]="12" />Change pending</span> }
                    </span>
                    @if (profile()?.mdcn_number) {
                      <span class="break-all font-sans text-body-sm font-medium text-ink">{{ profile()?.mdcn_number }}</span>
                    } @else {
                      <span class="flex items-start gap-1.5 font-sans text-body-sm text-warning">
                        <sd-icon name="circle-alert" [size]="16" class="mt-0.5 shrink-0" />
                        {{ locked() ? 'Not added yet. Use “Request a change” to add it — it is printed on your prescriptions.' : 'Not added yet. It is printed on your prescriptions — add it with Edit Profile.' }}
                      </span>
                    }
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
                      <span class="flex flex-wrap items-center gap-2 font-sans text-caption text-slate">
                        Qualifications
                        @if (isPending('qualification_entries')) { <span class="${PENDING_BADGE}"><sd-icon name="hourglass" [size]="12" />Change pending</span> }
                      </span>
                      @for (q of qualificationRows.controls; track $index) {
                        <span class="font-sans text-body-sm text-ink">{{ qualLine(q) }}</span>
                      }
                    </div>
                  }
                  @if (certificationRows.length) {
                    <div class="flex flex-col gap-2 border-b border-cloud pb-4">
                      <span class="flex flex-wrap items-center gap-2 font-sans text-caption text-slate">
                        Certifications
                        @if (isPending('certifications')) { <span class="${PENDING_BADGE}"><sd-icon name="hourglass" [size]="12" />Change pending</span> }
                      </span>
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

                <!-- Signature for prescriptions -->
                <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6" aria-labelledby="sig-heading">
                  <div class="flex flex-col gap-1">
                    <h3 id="sig-heading" class="flex items-center gap-2 font-heading text-body-lg text-ink">
                      <sd-icon name="signature" [size]="20" class="text-cerulean" />Signature for prescriptions
                    </h3>
                    <p class="font-sans text-caption text-slate">
                      Only you can add or change your signature. Each time it is used on a prescription, it is recorded.
                    </p>
                  </div>

                  @if (sigLoading()) {
                    <div class="sd-shimmer h-28 rounded-field" aria-busy="true"><span class="sr-only">Loading your signature…</span></div>
                  } @else if (sigBlocked()) {
                    <p class="flex items-start gap-2 rounded-field border border-cloud bg-glacier px-4 py-3 font-sans text-body-sm text-slate">
                      <sd-icon name="lock" [size]="18" class="mt-0.5 shrink-0" />
                      Your saved signature is kept, but it can't be viewed or changed while your account is suspended.
                    </p>
                  } @else if (sigLoadError()) {
                    <div class="flex flex-col items-center gap-3 rounded-field border border-cloud px-4 py-8 text-center">
                      <sd-icon name="wifi-off" [size]="26" class="text-alert" />
                      <p class="font-sans text-body-sm text-slate">{{ sigLoadError() }}</p>
                      <sd-button variant="secondary" size="sm" (click)="loadSignature()">
                        <sd-icon name="refresh-cw" [size]="16" />Try again
                      </sd-button>
                    </div>
                  } @else if (drawing()) {
                    <div class="flex flex-col gap-3">
                      <p class="font-sans text-body-sm text-ink">Draw your signature in the box with a mouse, finger or pen.</p>
                      <doc-signature-pad label="Draw your signature for prescriptions" [height]="180" (changed)="drawn.set($event)" />
                      <div class="flex flex-wrap gap-3">
                        <sd-button size="sm" [disabled]="!drawn() || sigBusy() !== ''" (click)="saveDrawn()">
                          <sd-icon name="save" [size]="16" />{{ sigBusy() === 'draw' ? 'Saving…' : 'Save signature' }}
                        </sd-button>
                        <sd-button variant="outline" size="sm" [disabled]="sigBusy() !== ''" (click)="cancelDrawing()">Cancel</sd-button>
                      </div>
                    </div>
                  } @else {
                    @if (signature()?.has_signature && signature()?.image) {
                      <!-- The API's data:image URL; Angular's URL sanitiser allows data:image/*. -->
                      <div class="flex items-center justify-center rounded-field border border-cloud bg-white p-4">
                        <img [src]="signature()?.image" alt="Your saved signature" class="max-h-28 w-auto max-w-full object-contain" />
                      </div>
                    } @else {
                      <div class="flex flex-col items-center gap-2 rounded-field border border-dashed border-ash bg-glacier/40 px-4 py-8 text-center">
                        <sd-icon name="signature" [size]="26" class="text-slate" />
                        <p class="font-sans text-body-sm text-slate">No signature saved yet</p>
                      </div>
                    }
                    <div class="flex flex-wrap gap-2">
                      <sd-button variant="outline" size="sm" [disabled]="sigBusy() !== ''" (click)="chooseSignatureFile(sigInput)">
                        <sd-icon name="upload" [size]="16" />{{ sigBusy() === 'upload' ? 'Uploading…' : 'Upload picture' }}
                      </sd-button>
                      <sd-button variant="outline" size="sm" [disabled]="sigBusy() !== ''" (click)="startDrawing()">
                        <sd-icon name="pen-line" [size]="16" />Draw signature
                      </sd-button>
                      @if (signature()?.has_signature) {
                        <sd-button variant="ghost" size="sm" [disabled]="sigBusy() !== ''" (click)="askRemoveSignature()">
                          <sd-icon name="trash-2" [size]="16" />{{ sigBusy() === 'remove' ? 'Removing…' : 'Remove' }}
                        </sd-button>
                      }
                    </div>
                    <p class="font-sans text-caption text-slate">Upload a PNG or JPG picture smaller than 500 KB. A dark signature on a white background works best.</p>
                    <input #sigInput type="file" accept="image/png,image/jpeg" class="hidden" (change)="onSignatureFile($event)" />
                  }
                  @if (sigError()) {
                    <sd-alert tone="error">{{ sigError() }}</sd-alert>
                  }
                </section>

                <!-- Licence, documents and terms: where an approved doctor renews their licence -->
                <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6" aria-labelledby="docs-heading">
                  <h3 id="docs-heading" class="flex items-center gap-2 font-heading text-body-lg text-ink">
                    <sd-icon name="file-check" [size]="20" class="text-cerulean" />Licence &amp; documents
                  </h3>
                  @if (account(); as o) {
                    <dl class="flex flex-col divide-y divide-cloud">
                      <div class="flex flex-wrap items-center justify-between gap-2 py-3">
                        <dt class="font-sans text-caption text-slate">MDCN full-registration certificate</dt>
                        <dd><doc-credential-status [status]="docStatus('mdcn_full_registration')" /></dd>
                      </div>
                      <div class="flex flex-wrap items-center justify-between gap-2 py-3">
                        <dt class="font-sans text-caption text-slate">Annual practising licence</dt>
                        <dd class="flex flex-col items-end gap-1">
                          <doc-credential-status [status]="docStatus('annual_practising_licence')" />
                          @if (licenceLine(); as line) { <span class="font-sans text-caption" [class]="line.tone">{{ line.text }}</span> }
                          @if (licenceRenewal(); as r) {
                            <!-- A renewal beside the licence in force: said on its own line. -->
                            <span class="flex items-start gap-1 text-right font-sans text-caption" [class]="r.status === 'rejected' ? 'text-alert' : 'text-slate'">
                              <sd-icon [name]="r.status === 'rejected' ? 'circle-x' : 'hourglass'" [size]="13" class="mt-0.5 shrink-0" />
                              <span class="min-w-0 whitespace-pre-line break-words">{{ renewalText(r) }}</span>
                            </span>
                          }
                        </dd>
                      </div>
                      <div class="flex flex-wrap items-center justify-between gap-2 py-3">
                        <dt class="font-sans text-caption text-slate">Practitioner terms</dt>
                        <dd class="font-sans text-body-sm text-ink">
                          @if (o.terms.accepted) {
                            <span class="inline-flex items-center gap-1 text-sage"><sd-icon name="circle-check" [size]="14" />Version {{ o.terms.accepted_version }} accepted</span>
                          } @else {
                            <span class="inline-flex items-center gap-1 text-warning"><sd-icon name="circle-alert" [size]="14" />Version {{ o.terms.current_version }} to accept</span>
                          }
                        </dd>
                      </div>
                    </dl>
                  } @else {
                    <p class="font-sans text-body-sm text-slate">Your MDCN certificate, practising licence and the practitioner terms.</p>
                  }
                  <div class="flex flex-wrap gap-2">
                    <a routerLink="/onboarding/credentials" class="inline-flex min-h-11 items-center gap-2 rounded-field border border-cloud px-4 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean">
                      <sd-icon name="upload" [size]="16" />Manage documents
                    </a>
                    <a routerLink="/onboarding/terms" class="inline-flex min-h-11 items-center gap-2 rounded-field border border-cloud px-4 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean">
                      <sd-icon name="scroll-text" [size]="16" />Practitioner terms
                    </a>
                  </div>
                </section>
              </div>
            </div>
          }

          @default {
            <!-- 'edit': the whole profile (verified details read-only once approved);
                 'changes': a request to change the verified details, for a reviewer. -->
            @let changing = view() === 'changes';
            <header class="flex items-start justify-between gap-4">
              <div class="flex flex-col gap-1">
                <h1 class="font-heading text-h3 text-ink">{{ changing ? 'Request a change' : 'Edit Profile' }}</h1>
                @if (changing) {
                  <p class="max-w-2xl font-sans text-body text-slate">
                    These details were verified when you were approved. A reviewer checks your change first — until then patients and your prescriptions show your current details.
                  </p>
                }
              </div>
              <button type="button" class="flex min-h-11 shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean" (click)="cancelEdit()">
                <sd-icon name="chevron-right" [size]="18" class="rotate-180" />Back
              </button>
            </header>

            @if (!changing) {
            <!-- Photo -->
            <section class="flex flex-col items-center gap-4 rounded-card border border-cloud bg-white p-6 sm:flex-row">
              <div class="relative shrink-0">
                @if (photoSrc()) {
                  <img [src]="photoSrc()" alt="" width="96" height="96" class="size-24 rounded-full object-cover" />
                } @else {
                  <span class="flex size-24 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h3 text-cerulean">{{ initials() || 'DR' }}</span>
                }
                <button type="button" class="absolute bottom-0 right-0 flex size-9 items-center justify-center rounded-full bg-cerulean text-white ring-2 ring-white transition-opacity disabled:opacity-60" [disabled]="uploadingAvatar()" aria-label="Change photo" (click)="openAvatar()">
                  @if (uploadingAvatar()) {
                    <span class="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white"></span>
                  } @else { <sd-icon name="camera" [size]="16" /> }
                </button>
              </div>
              <div class="flex flex-col items-center gap-3 sm:flex-row">
                <button type="button" class="font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean" (click)="openAvatar()">Replace photo</button>
                @if (photoSrc()) {
                  <button type="button" class="flex items-center gap-1.5 rounded-field border border-alert/40 px-4 py-2 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5 disabled:opacity-60" [disabled]="uploadingAvatar()" (click)="deletePhoto()">
                    <sd-icon name="trash-2" [size]="16" />Delete photo
                  </button>
                }
              </div>
            </section>
            }

            <form [class]="changing ? 'grid max-w-3xl gap-6' : 'grid gap-6 lg:grid-cols-2'" [formGroup]="form" (ngSubmit)="save()">
              @if (!changing) {
              <!-- Personal -->
              <section class="flex h-fit flex-col gap-5 rounded-card border border-cloud bg-white p-6">
                <h3 class="flex items-center gap-2 font-heading text-body-lg text-ink"><sd-icon name="user" [size]="20" class="text-cerulean" />Personal Information</h3>
                @if (locked()) {
                  <div class="flex w-full flex-col gap-2">
                    <span class="font-sans text-body font-semibold text-ink">Full name</span>
                    <p class="${LOCKED_VALUE}"><sd-icon name="lock" [size]="16" class="shrink-0 text-slate" /><span class="min-w-0 break-words">{{ profile()?.name }}</span></p>
                  </div>
                } @else {
                  <sd-input label="Full name" [required]="true" formControlName="name" [error]="fieldError('name')" />
                }
                <sd-input label="Email address" type="email" formControlName="email" [error]="fieldError('email')" />
                <sd-input label="Phone number" type="tel" formControlName="phone" />
                <sd-input label="Date of birth" type="date" formControlName="dob" [max]="today" [error]="dobError()" />
                <div class="flex w-full flex-col gap-2">
                  <span class="font-sans text-body font-semibold text-ink">Gender</span>
                  <sd-search-select size="lg" placeholder="Select" [options]="genderOptions" [value]="form.controls.gender.value" (valueChange)="form.controls.gender.setValue($event)" />
                </div>
                <sd-input label="Country / Location" formControlName="country" />
              </section>
              }

              <!-- Professional -->
              <section class="flex flex-col gap-5 rounded-card border border-cloud bg-white p-6">
                <h3 class="flex items-center gap-2 font-heading text-body-lg text-ink"><sd-icon name="briefcase" [size]="20" class="text-cerulean" />{{ changing ? 'Verified details' : 'Professional Information' }}</h3>
                @if (identityEditable()) {
                  @if (changing) {
                    <sd-input label="Full name" [required]="true" formControlName="name" [error]="fieldError('name')" />
                  }
                  <sd-input label="Medical Speciality" [required]="true" formControlName="specialty" [error]="fieldError('specialty')" />
                  <div class="flex w-full flex-col gap-1.5">
                    <sd-input label="MDCN registration number" placeholder="e.g. MDCN/12345" formControlName="mdcn" autocomplete="off" [error]="mdcnError()" />
                    @if (!mdcnError()) {
                      <span class="font-sans text-caption text-slate">Printed on your prescriptions. Letters, numbers, / or -.</span>
                    }
                  </div>
                } @else {
                  <p class="flex items-start gap-2 rounded-field bg-glacier px-3 py-2 font-sans text-caption text-slate">
                    <sd-icon name="lock" [size]="14" class="mt-0.5 shrink-0" />
                    Your name, speciality, MDCN number, qualifications and certifications were verified when you were approved. To change them, save or cancel here, then use “Request a change” on your profile.
                  </p>
                  <div class="flex w-full flex-col gap-2">
                    <span class="font-sans text-body font-semibold text-ink">Medical Speciality</span>
                    <p class="${LOCKED_VALUE}"><sd-icon name="lock" [size]="16" class="shrink-0 text-slate" /><span class="min-w-0 break-words">{{ profile()?.specialty }}</span></p>
                  </div>
                  <div class="flex w-full flex-col gap-2">
                    <span class="font-sans text-body font-semibold text-ink">MDCN registration number</span>
                    <p class="${LOCKED_VALUE}"><sd-icon name="lock" [size]="16" class="shrink-0 text-slate" /><span class="min-w-0 break-all">{{ profile()?.mdcn_number || '—' }}</span></p>
                  </div>
                }
                @if (!changing) {
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
                }

                @if (!identityEditable()) {
                  <!-- Verified entries: read-only once approved -->
                  <div class="flex w-full flex-col gap-2">
                    <span class="font-sans text-body font-semibold text-ink">Qualifications</span>
                    @for (q of qualificationRows.controls; track $index) {
                      <span class="flex items-start gap-2 font-sans text-body-sm text-ink"><sd-icon name="lock" [size]="14" class="mt-1 shrink-0 text-slate" />{{ qualLine(q) }}</span>
                    } @empty {
                      <span class="font-sans text-body-sm text-slate">None added.</span>
                    }
                  </div>
                  <div class="flex w-full flex-col gap-2">
                    <span class="font-sans text-body font-semibold text-ink">Certifications</span>
                    @for (c of certificationRows.controls; track $index) {
                      <span class="flex items-start gap-2 font-sans text-body-sm text-ink"><sd-icon name="lock" [size]="14" class="mt-1 shrink-0 text-slate" />{{ certLine(c) }}</span>
                    } @empty {
                      <span class="font-sans text-body-sm text-slate">None added.</span>
                    }
                  </div>
                } @else {
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
                }
              </section>

              @if (saveError()) {
                <p class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert lg:col-span-2" role="alert">{{ saveError() }}</p>
              }
              <div class="flex justify-end gap-3 lg:col-span-2">
                <sd-button variant="outline" type="button" (click)="cancelEdit()">Cancel</sd-button>
                <sd-button type="submit" [disabled]="saving()">
                  {{ saving() ? (changing ? 'Sending…' : 'Saving…') : changing ? 'Send for review' : 'Save changes' }}
                </sd-button>
              </div>
            </form>
          }
        }
      }
    </div>

    <!-- Avatar upload (the design-system dialog; nothing closes it while uploading). -->
    <sd-dialog
      [open]="avatarModalOpen()"
      title="Update profile photo"
      subtitle="Drag an image here, or choose a file."
      [busy]="uploadingAvatar()"
      (closed)="avatarModalOpen.set(false)"
    >
          <div class="flex flex-col items-center gap-3 rounded-card border-2 border-dashed px-6 py-10 text-center transition-colors" [class]="avatarDragging() ? 'border-cerulean bg-frost/40' : 'border-cloud bg-glacier/40'"
            (dragover)="$event.preventDefault(); avatarDragging.set(true)" (dragleave)="avatarDragging.set(false)" (drop)="onAvatarDrop($event)">
            @if (uploadingAvatar()) {
              <span class="size-7 animate-spin rounded-full border-2 border-cloud border-t-cerulean"></span>
              <span class="font-sans text-body-sm text-slate">Uploading…</span>
            } @else {
              <span class="flex size-12 items-center justify-center rounded-full bg-frost text-cerulean"><sd-icon name="upload" [size]="24" /></span>
              <p class="font-sans text-body font-semibold text-ink">Drag &amp; drop your photo</p>
              <p class="font-sans text-caption text-slate">PNG, JPG, WEBP or GIF · up to 2MB</p>
              <button type="button" data-autofocus class="mt-1 min-h-11 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2" (click)="avatarInput.click()">Choose from file</button>
            }
          </div>
          <input #avatarInput type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="hidden" (change)="onAvatarSelected($event)" />
          @if (avatarError()) {
            <p role="alert" class="mt-4 rounded-field bg-alert/10 px-4 py-2 font-sans text-caption text-alert">{{ avatarError() }}</p>
          }
    </sd-dialog>

    <!-- Public profile preview: what patients see. -->
    <sd-dialog
      [open]="publicOpen()"
      title="Your public profile"
      subtitle="This is how patients see you when they book."
      size="xl"
      (closed)="publicOpen.set(false)"
    >
      <sd-doctor-profile-card [data]="publicData()" [photoUrl]="photoSrc()" />
    </sd-dialog>
  `,
})
export class DoctorProfile implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(DoctorApi);
  private readonly auth = inject(StaffAuthService);
  private readonly standing = inject(DoctorStandingStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogs = inject(DialogService);
  /** The edit form as it was when editing started (to tell real changes from none). */
  private editSnapshot: string | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  /** The read view, the edit form, or a change request for the verified (locked) details. */
  protected readonly view = signal<'view' | 'edit' | 'changes'>('view');
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  /** Field errors from the last failed save (e.g. `mdcn_number`), shown inline. */
  protected readonly serverErrors = signal<Record<string, string>>({});
  protected readonly toast = signal('');

  // Signature for prescriptions (saved separately from the profile form).
  protected readonly signature = signal<DoctorSignatureDto | null>(null);
  protected readonly sigLoading = signal(true);
  protected readonly sigLoadError = signal('');
  protected readonly sigBusy = signal<'' | 'upload' | 'draw' | 'remove'>('');
  protected readonly sigError = signal('');
  protected readonly drawing = signal(false);
  protected readonly drawn = signal<string | null>(null);
  /** Suspended: the signature can't be read or changed (the API refuses it). */
  protected readonly sigBlocked = signal(false);

  protected readonly profile = signal<DoctorProfileDto | null>(null);

  // ----- Verified details (approved doctors): locked, changed only through a review -----
  /** Approved (or suspended): name, specialty, MDCN number, qualifications and certifications are locked. */
  protected readonly locked = computed(() => (this.profile()?.locked_fields?.length ?? 0) > 0);
  /** The verified details are editable here: while onboarding, or in a change request. */
  protected readonly identityEditable = computed(() => !this.locked() || this.view() === 'changes');
  /** The change request waiting for a reviewer (null: none). */
  protected readonly pending = computed(() => {
    const p = this.profile()?.pending_changes;
    return p && Object.keys(p).length > 0 ? p : null;
  });
  protected readonly pendingRows = computed<PendingRow[]>(() => {
    const p = this.pending();
    const now = this.profile();
    if (!p || !now) return [];
    const rows: PendingRow[] = [];
    if (p.name !== undefined) rows.push({ label: CHANGE_FIELD_LABELS['name'], value: p.name, current: now.name });
    if (p.specialty !== undefined) rows.push({ label: CHANGE_FIELD_LABELS['specialty'], value: p.specialty, current: now.specialty });
    if (p.mdcn_number !== undefined) {
      rows.push({ label: CHANGE_FIELD_LABELS['mdcn_number'], value: p.mdcn_number ?? '', current: now.mdcn_number ?? '' });
    }
    if (p.qualification_entries !== undefined) {
      rows.push({ label: 'Qualifications', value: entriesText(p.qualification_entries), current: entriesText(now.qualification_entries) });
    } else if (p.qualifications !== undefined) {
      rows.push({ label: 'Qualifications', value: p.qualifications ?? '', current: now.qualifications ?? '' });
    }
    if (p.certifications !== undefined) {
      rows.push({ label: CHANGE_FIELD_LABELS['certifications'], value: entriesText(p.certifications), current: entriesText(now.certifications) });
    }
    return rows;
  });
  protected readonly withdrawing = signal(false);
  protected readonly withdrawError = signal('');

  // ----- Licence & documents (from the onboarding payload) -----
  protected readonly account = this.standing.onboarding;
  /** The current licence's expiry, said plainly (with its urgency). */
  protected readonly licenceLine = computed<{ text: string; tone: string } | null>(() => {
    const l = this.account()?.licence;
    if (!l?.expires_at) return null;
    if (l.status === 'expired') return { text: `Expired ${ymdLabel(l.expires_at)}`, tone: 'text-alert' };
    if (l.status === 'expiring') {
      return { text: `Expires ${inDaysLabel(daysUntil(l.expires_at, todayLocal()))} (${ymdLabel(l.expires_at)})`, tone: 'text-warning' };
    }
    return { text: `Valid until ${ymdLabel(l.expires_at)}`, tone: 'text-slate' };
  });
  /** The licence in force, and a renewal waiting for verification (or turned down) beside it. */
  private readonly licenceDocs = computed(() => licenceDocuments(this.account()?.credentials, this.account()?.licence));
  protected readonly licenceRenewal = computed(() => this.licenceDocs().renewal);
  protected readonly renewalText = renewalText;
  protected readonly photoPath = signal<string | null>(null);
  protected readonly photoSrc = computed(() => this.api.assetUrl(this.photoPath()));
  protected readonly uploadingAvatar = signal(false);
  protected readonly avatarModalOpen = signal(false);
  /**
   * Why the chosen photo wasn't used (wrong type, too large, upload failed) —
   * shown inside the dialog: the page's toast sits under the modal, unseen.
   */
  protected readonly avatarError = signal('');
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
    mdcn: ['', [Validators.pattern(MDCN_PATTERN)]],
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
    // A server field error goes away once that field is edited.
    const clearOnEdit: [AbstractControl, string][] = [
      [this.form.controls.name, 'name'],
      [this.form.controls.specialty, 'specialty'],
      [this.form.controls.email, 'email'],
      [this.form.controls.dob, 'date_of_birth'],
      [this.form.controls.mdcn, 'mdcn_number'],
    ];
    for (const [control, key] of clearOnEdit) {
      control.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
        if (!(key in this.serverErrors())) return;
        this.serverErrors.update((errs) => {
          const next = { ...errs };
          delete next[key];
          return next;
        });
      });
    }
    this.loadSignature();
    // Licence, documents and terms (the "Licence & documents" card).
    void this.standing.load();
    this.api
      .getProfile()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.apply(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loadError.set(apiErrorMessage(err, 'Could not load your profile.'));
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
      mdcn: p.mdcn_number ?? '',
      email: p.email ?? '',
      phone: p.phone ?? '',
      dob: p.date_of_birth ?? '',
      gender: p.gender ? p.gender.charAt(0).toUpperCase() + p.gender.slice(1) : '',
      country: p.country ?? p.location ?? '',
      years: p.years_experience != null ? String(p.years_experience) : '',
      bio: p.bio ?? '',
    });
  }

  /** The verified fields' controls: read-only (and not validated) in the edit form once approved. */
  private identityControls(): AbstractControl[] {
    return [this.form.controls.name, this.form.controls.specialty, this.form.controls.mdcn];
  }

  private setIdentityEditable(editable: boolean): void {
    for (const c of this.identityControls()) {
      if (editable) c.enable({ emitEvent: false });
      else c.disable({ emitEvent: false });
    }
  }

  protected startEdit(): void {
    const p = this.profile();
    if (p) this.apply(p);
    this.setIdentityEditable(!this.locked());
    this.saveError.set('');
    this.serverErrors.set({});
    this.view.set('edit');
    this.editSnapshot = this.formSnapshot();
  }

  /**
   * "Request a change": the verified details, starting from the request
   * already waiting (if any) so editing it updates that request.
   */
  protected startChanges(): void {
    const p = this.profile();
    if (!p) return;
    this.apply(p);
    this.setIdentityEditable(true);
    const want = this.pending();
    if (want) {
      this.form.patchValue({
        name: want.name ?? p.name ?? '',
        specialty: want.specialty ?? p.specialty ?? '',
        mdcn: want.mdcn_number !== undefined ? (want.mdcn_number ?? '') : (p.mdcn_number ?? ''),
      });
      if (want.qualification_entries) this.fillEntries(this.qualificationRows, want.qualification_entries, ['title', 'institution', 'year']);
      if (want.certifications) this.fillEntries(this.certificationRows, want.certifications, ['name', 'body', 'year']);
    }
    this.saveError.set('');
    this.serverErrors.set({});
    this.view.set('changes');
    this.editSnapshot = this.formSnapshot();
  }

  /** Cancel / Back out of the edit form — asking first when something was changed. */
  protected async cancelEdit(): Promise<void> {
    if (this.hasUnsavedChanges() && !(await this.dialogs.confirmLeave(this.discardCopy()))) return;
    this.discardEdit();
  }

  private discardEdit(): void {
    const p = this.profile();
    if (p) this.apply(p);
    this.setIdentityEditable(true);
    this.serverErrors.set({});
    this.view.set('view');
    this.editSnapshot = null;
  }

  /**
   * Route guard hook (`unsavedChangesGuard`): the edit or change-request form
   * holds changes that haven't been saved or sent.
   */
  hasUnsavedChanges(): boolean {
    return this.view() !== 'view' && this.editSnapshot !== null && this.formSnapshot() !== this.editSnapshot;
  }

  /** The guard's question (and Cancel's), worded for the form that is open. */
  readonly leaveCopy = (): LeaveCopy => this.discardCopy();

  private discardCopy(): LeaveCopy {
    return this.view() === 'changes'
      ? {
          title: 'Discard your change request?',
          message: "The changes you've made to your verified details won't be sent for review.",
          confirmLabel: 'Discard changes',
          cancelLabel: 'Keep editing',
        }
      : {
          title: 'Discard changes?',
          message: "The changes you've made to your profile won't be saved.",
          confirmLabel: 'Discard changes',
          cancelLabel: 'Keep editing',
        };
  }

  /** Everything the edit form changes, as one comparable string. */
  private formSnapshot(): string {
    return JSON.stringify({ form: this.form.getRawValue(), expertise: this.expertise(), languages: this.languages() });
  }

  private fillEntries(arr: FormArray<FormGroup>, rows: readonly object[], keys: readonly string[]): void {
    arr.clear();
    for (const row of rows) {
      const r = row as Record<string, string | undefined>;
      arr.push(this.fb.group(Object.fromEntries(keys.map((k) => [k, [r[k] ?? '']]))));
    }
  }

  protected fieldError(name: 'name' | 'specialty' | 'email'): string {
    const c = this.form.controls[name];
    if (!c.errors || (!c.touched && !c.dirty)) return this.serverErrors()[name] ?? '';
    if (c.errors['required']) return 'This field is required';
    if (c.errors['email']) return 'Enter a valid email address';
    return this.serverErrors()[name] ?? '';
  }

  protected mdcnError(): string {
    const c = this.form.controls.mdcn;
    if (c.errors?.['pattern'] && (c.touched || c.dirty)) {
      return 'Enter your MDCN registration number (3–40 letters, numbers, / or -)';
    }
    return this.serverErrors()['mdcn_number'] ?? '';
  }

  protected dobError(): string {
    const c = this.form.controls.dob;
    if (!c.errors || (!c.touched && !c.dirty)) return this.serverErrors()['date_of_birth'] ?? '';
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
  protected openAvatar(): void {
    this.avatarError.set('');
    this.avatarModalOpen.set(true);
  }
  private async processAvatar(file: File): Promise<void> {
    this.avatarError.set('');
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
      this.avatarError.set('Use a PNG, JPG, WEBP or GIF image.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      this.avatarError.set('Image must be 2MB or smaller.');
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
      this.avatarError.set(apiErrorMessage(err, 'Could not upload your photo.'));
    } finally {
      this.uploadingAvatar.set(false);
    }
  }
  /** "Remove your photo?" — removed inside the dialog (spinner, inline error). */
  protected async deletePhoto(): Promise<void> {
    if (this.uploadingAvatar()) return;
    const { confirmed } = await this.dialogs.confirm({
      tone: 'danger',
      icon: 'image-off',
      title: 'Remove your photo?',
      message: 'Patients will see your initials on your public profile instead.',
      confirmLabel: 'Remove photo',
      cancelLabel: 'Keep it',
      action: async () => {
        const res = await firstValueFrom(this.api.removeAvatar());
        this.profile.set(res.data);
        this.photoPath.set(null);
      },
      errorMessage: (err) => apiErrorMessage(err, 'Could not remove your photo.'),
    });
    if (confirmed) this.showToast('Profile photo removed');
  }

  /** The verified (locked) fields as the form holds them, ready for the API. */
  private identityValues(): Pick<DoctorProfileUpdate, LockedField> {
    const v = this.form.getRawValue();
    return {
      name: v.name.trim(),
      specialty: v.specialty.trim(),
      // Printed on prescriptions; an empty value clears it (the API upper-cases).
      mdcn_number: v.mdcn.trim(),
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
    };
  }

  // ----- Save -----
  protected save(): void {
    if (this.view() === 'changes') {
      this.submitChanges();
      return;
    }
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.saving.set(true);
    this.saveError.set('');
    this.serverErrors.set({});

    const v = this.form.getRawValue();
    // Once approved the verified fields are left out: sending them unchanged would
    // take back a change request waiting for review (they change through "Request a change").
    const identity = this.locked() ? {} : this.identityValues();
    this.api
      .updateProfile({
        ...identity,
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
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.apply(res.data);
          this.setIdentityEditable(true);
          this.saving.set(false);
          this.view.set('view');
          this.showToast('Your Profile has successfully updated');
        },
        error: (err: unknown) => {
          this.saving.set(false);
          this.serverErrors.set(apiErrorFields(err));
          this.saveError.set(apiErrorMessage(err, 'Could not save your profile.'));
        },
      });
  }

  /**
   * Send the verified details for review: only those fields go, and the API
   * stages what differs from the approved values in `pending_changes` (a value
   * set back to the approved one drops out of the request).
   */
  private submitChanges(): void {
    const controls = this.identityControls();
    for (const c of controls) c.markAsTouched();
    if (controls.some((c) => c.invalid)) return;
    const p = this.profile();
    const next = this.identityValues();
    const same =
      !!p &&
      next.name === (p.name ?? '') &&
      next.specialty === (p.specialty ?? '') &&
      (next.mdcn_number ?? '').toUpperCase() === (p.mdcn_number ?? '').toUpperCase() &&
      JSON.stringify(next.qualification_entries?.filter((q) => q.title || q.institution || q.year)) ===
        JSON.stringify((p.qualification_entries ?? []).map((q) => ({ title: q.title ?? '', institution: q.institution ?? '', year: q.year ?? '' }))) &&
      JSON.stringify(next.certifications?.filter((c) => c.name || c.body || c.year)) ===
        JSON.stringify((p.certifications ?? []).map((c) => ({ name: c.name ?? '', body: c.body ?? '', year: c.year ?? '' })));
    if (same && !this.pending()) {
      this.saveError.set('These are your current details — change at least one to send a request.');
      return;
    }

    this.saving.set(true);
    this.saveError.set('');
    this.serverErrors.set({});
    this.api
      .updateProfile(next)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.apply(res.data);
          this.saving.set(false);
          this.view.set('view');
          this.showToast(
            res.data.pending_changes ? 'Your change was sent for review' : 'Your change request was withdrawn — nothing differs from your verified details',
          );
          void this.standing.load(true); // the dashboard's "waiting for review"
        },
        error: (err: unknown) => {
          this.saving.set(false);
          this.serverErrors.set(apiErrorFields(err));
          this.saveError.set(apiErrorMessage(err, 'Could not send your change for review.'));
        },
      });
  }

  /** Take back the change request waiting for review — asked first; withdrawn inside the dialog. */
  protected async askWithdraw(): Promise<void> {
    if (this.withdrawing()) return;
    this.withdrawError.set('');
    const { confirmed } = await this.dialogs.confirm({
      tone: 'warning',
      icon: 'undo-2',
      title: 'Withdraw your change request?',
      message: 'Your verified details stay as they are, and the reviewer no longer sees the request.',
      confirmLabel: 'Withdraw request',
      cancelLabel: 'Keep it',
      action: async () => {
        this.withdrawing.set(true);
        try {
          this.apply((await firstValueFrom(this.api.withdrawProfileChanges())).data);
        } finally {
          this.withdrawing.set(false);
        }
      },
      errorMessage: (err) => apiErrorMessage(err, 'Could not withdraw your change request.'),
    });
    if (!confirmed) return;
    this.showToast('Your change request was withdrawn');
    void this.standing.load(true);
  }

  /** "Change pending" next to a verified field. */
  protected isPending(field: LockedField): boolean {
    const p = this.pending();
    if (!p) return false;
    return field === 'qualification_entries' ? 'qualification_entries' in p || 'qualifications' in p : field in p;
  }

  protected docStatus(type: CredentialType): CredentialChipState {
    const doc =
      type === 'annual_practising_licence' ? this.licenceDocs().current : latestCredential(this.account()?.credentials, type);
    return doc?.status ?? 'missing';
  }

  protected date(iso: string | null | undefined): string {
    if (!iso) return '';
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }

  // ----- Signature for prescriptions -----
  protected loadSignature(): void {
    this.sigLoading.set(true);
    this.sigLoadError.set('');
    this.sigBlocked.set(false);
    this.api
      .getSignature()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.signature.set(res.data);
          this.sigLoading.set(false);
        },
        error: (err: unknown) => {
          // Suspended: the signature is kept but closed (said plainly, no "try again").
          if (doctorStandingCode(err) === 'doctor_suspended') this.sigBlocked.set(true);
          else this.sigLoadError.set(apiErrorMessage(err, 'Could not load your saved signature.'));
          this.sigLoading.set(false);
        },
      });
  }

  protected chooseSignatureFile(input: HTMLInputElement): void {
    if (this.sigBusy()) return;
    this.sigError.set('');
    input.click();
  }

  protected onSignatureFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.sigBusy()) return;
    this.sigError.set('');
    // Some systems leave `type` empty — fall back to the file extension.
    const isPicture = file.type
      ? /^image\/(png|jpe?g)$/.test(file.type)
      : /\.(png|jpe?g)$/i.test(file.name);
    if (!isPicture) {
      this.sigError.set('Choose a PNG or JPG picture of your signature.');
      return;
    }
    if (file.size > SIGNATURE_MAX_BYTES) {
      this.sigError.set(`This picture is ${Math.ceil(file.size / 1024)} KB. The limit is 500 KB.`);
      return;
    }
    this.storeSignature(file, 'upload');
  }

  protected startDrawing(): void {
    if (this.sigBusy()) return;
    this.sigError.set('');
    this.drawn.set(null);
    this.drawing.set(true);
  }

  protected cancelDrawing(): void {
    if (this.sigBusy()) return;
    this.drawing.set(false);
    this.drawn.set(null);
    this.sigError.set('');
  }

  protected saveDrawn(): void {
    const dataUrl = this.drawn();
    if (!dataUrl || this.sigBusy()) return;
    this.storeSignature(dataUrl, 'draw');
  }

  /** "Remove your signature?" — removed inside the dialog (spinner, inline error), never closed first. */
  protected async askRemoveSignature(): Promise<void> {
    if (this.sigBusy()) return;
    this.sigError.set('');
    const { confirmed } = await this.dialogs.confirm({
      tone: 'danger',
      icon: 'trash-2',
      title: 'Remove your signature?',
      message: "You'll need to draw your signature each time you send a prescription, until you save a new one.",
      confirmLabel: 'Remove signature',
      cancelLabel: 'Keep it',
      action: async () => {
        this.sigBusy.set('remove');
        try {
          this.applySignature((await firstValueFrom(this.api.deleteSignature())).data);
        } finally {
          this.sigBusy.set('');
        }
      },
      errorMessage: (err) => apiErrorMessage(err, 'Could not remove your signature. Please try again.'),
    });
    if (confirmed) this.showToast('Your signature was removed');
  }

  private storeSignature(source: File | string, mode: 'upload' | 'draw'): void {
    this.sigBusy.set(mode);
    this.sigError.set('');
    this.api
      .saveSignature(source)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.applySignature(res.data);
          this.sigBusy.set('');
          this.drawing.set(false);
          this.drawn.set(null);
          this.showToast('Your signature was saved');
        },
        error: (err: unknown) => {
          this.sigBusy.set('');
          this.sigError.set(apiErrorMessage(err, 'Could not save your signature. Please try again.'));
        },
      });
  }

  private applySignature(sig: DoctorSignatureDto): void {
    this.signature.set(sig);
    this.profile.update((p) => (p ? { ...p, has_signature: sig.has_signature } : p));
  }

  private showToast(message: string): void {
    this.toast.set(message);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3500);
  }
}
