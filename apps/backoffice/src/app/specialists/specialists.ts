import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type {
  CreateSpecialistParams,
  DoctorLoginStateDto,
  DoctorOnboardingDto,
  OnboardingItemKey,
  SpecialistAdminDto,
  SpecialistOnboardingReviewDto,
  SpecialistStatus,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { ReviewQueue } from './review-queue';

interface Draft {
  name: string;
  specialty: string;
  email: string;
  consultation_fee: string;
  location: string;
  years_experience: string;
  bio: string;
  available: boolean;
  verified: boolean;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  specialty: '',
  email: '',
  consultation_fee: '',
  location: '',
  years_experience: '',
  bio: '',
  available: true,
  verified: false,
};

interface Row {
  id: string;
  name: string;
  specialty: string;
  email: string;
  /** The email as last saved — invites go to this one. */
  savedEmail: string;
  consultation_fee: string;
  photo_url: string;
  available: boolean;
  verified: boolean;
  status: SpecialistStatus;
  login: DoctorLoginStateDto | null;
  saving: boolean;
  saved: boolean;
  error: string;
  inviting: boolean;
  /** Outcome of the last invite (success text), shown under the card. */
  inviteNotice: string;
  /** Non-production only: the set-password link, for testing without mail. */
  devLink: string;
}

type Filter = 'all' | 'review' | 'onboarding' | 'approved';

const FILTERS: readonly Filter[] = ['all', 'review', 'onboarding', 'approved'];

interface Badge {
  readonly label: string;
  readonly cls: string;
}

const CHECKLIST: readonly { key: OnboardingItemKey; label: string }[] = [
  { key: 'photo', label: 'Profile photo' },
  { key: 'bio', label: 'Bio' },
  { key: 'qualifications', label: 'Qualifications' },
  { key: 'mdcn', label: 'MDCN registration number' },
  { key: 'signature', label: 'Signature' },
  { key: 'availability', label: 'Availability (weekly hours or open slots)' },
  { key: 'payout', label: 'Payout account' },
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Specialists management (route `/specialists`) — onboard a specialist, invite
 * them by email, review their submitted profile (checklist, approve / send back
 * with a reason), and edit contact email, fee and availability.
 */
@Component({
  selector: 'bo-specialists',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Specialists</h1>
          <p class="font-sans text-body text-slate">Onboard and invite doctors, review their profiles, and edit contact email, fee and availability.</p>
        </div>
        <button type="button" class="flex items-center gap-2 rounded-field bg-cerulean px-4 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="openCreate()">
          <sd-icon name="plus" [size]="18" />New specialist
        </button>
      </header>

      @if (loading()) {
        <div class="sd-shimmer h-40 rounded-card"></div>
      } @else if (listError()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ listError() }}</p>
        </div>
      } @else {
        <!-- Filter by where each doctor is in onboarding -->
        <div class="flex flex-wrap gap-2" role="group" aria-label="Filter specialists">
          @for (f of filters(); track f.value) {
            <button
              type="button"
              [attr.aria-pressed]="filter() === f.value"
              class="flex items-center gap-1.5 rounded-pill px-3 py-1.5 font-sans text-body-sm transition-colors"
              [class]="filter() === f.value ? 'bg-cerulean text-white' : (f.value === 'review' && f.count > 0 ? 'bg-warning/10 text-ink ring-1 ring-warning/40 hover:bg-warning/20' : 'bg-white text-slate ring-1 ring-cloud hover:text-ink')"
              (click)="filter.set(f.value)"
            >
              {{ f.label }}
              <span class="rounded-pill px-1.5 text-caption font-semibold" [class]="filter() === f.value ? 'bg-white/20' : (f.value === 'review' && f.count > 0 ? 'bg-warning/20' : 'bg-glacier')">{{ f.count }}</span>
            </button>
          }
        </div>

        <ul class="flex flex-col gap-3">
          @for (s of visible(); track s.id) {
            <li class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-4 sm:p-5">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="flex min-w-0 flex-col gap-1.5">
                  <span class="break-words font-heading text-body font-semibold text-ink">{{ s.name }}</span>
                  <span class="font-sans text-caption text-cerulean">{{ s.specialty }}</span>
                  <span class="flex flex-wrap items-center gap-1.5">
                    <span class="rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold" [class]="statusBadge(s).cls">{{ statusBadge(s).label }}</span>
                    <span class="rounded-pill px-2.5 py-0.5 font-sans text-caption" [class]="loginBadge(s).cls">{{ loginBadge(s).label }}</span>
                  </span>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  @if (s.saved) {
                    <span class="flex items-center gap-1 font-sans text-caption text-sage"><sd-icon name="circle-check" [size]="16" />Saved</span>
                  }
                  <button type="button" class="flex items-center gap-1.5 rounded-field border px-3 py-2 font-sans text-body-sm font-semibold transition-colors" [class]="s.status === 'pending_review' ? 'border-warning/40 bg-warning/10 text-ink hover:bg-warning/20' : 'border-cloud text-cerulean hover:border-cerulean'" (click)="openReview(s)">
                    <sd-icon name="list-checks" [size]="16" />{{ s.status === 'pending_review' ? 'Review' : 'Onboarding' }}
                  </button>
                  @if (canInvite(s)) {
                    <button type="button" class="flex items-center gap-1.5 rounded-field border border-cloud px-3 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="s.inviting || inviteHint(s) !== ''" [attr.title]="inviteHint(s) || null" (click)="invite(s.id)">
                      <sd-icon name="mail" [size]="16" />{{ s.inviting ? 'Sending…' : (s.login ? 'Resend invite' : 'Invite') }}
                    </button>
                  }
                  <button type="button" class="flex items-center gap-2 rounded-field bg-cerulean px-4 py-2 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="s.saving" (click)="save(s.id)">
                    {{ s.saving ? 'Saving…' : 'Save' }}
                  </button>
                </div>
              </div>

              @if (canInvite(s) && inviteHint(s); as hint) {
                <p class="font-sans text-caption text-slate">{{ hint }}</p>
              }

              <div class="grid gap-4 sm:grid-cols-2">
                <label class="flex min-w-0 flex-col gap-1.5">
                  <span class="font-sans text-caption font-semibold text-slate">Contact email</span>
                  <input type="email" [value]="s.email" (input)="setField(s.id, 'email', $any($event.target).value)" placeholder="doctor@example.com" class="w-full rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none" />
                </label>
                <label class="flex min-w-0 flex-col gap-1.5">
                  <span class="font-sans text-caption font-semibold text-slate">Consultation fee (₦)</span>
                  <input type="number" min="0" step="500" [value]="s.consultation_fee" (input)="setField(s.id, 'consultation_fee', $any($event.target).value)" class="w-full rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" />
                </label>
              </div>

              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-caption font-semibold text-slate">Photo URL</span>
                <div class="flex items-center gap-3">
                  @if (photoSrc(s.photo_url); as src) {
                    <img [src]="src" [alt]="s.name" class="size-10 shrink-0 rounded-full border border-cloud object-cover" />
                  } @else {
                    <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-sans text-caption font-semibold text-cerulean">{{ initials(s.name) }}</span>
                  }
                  <input type="url" [value]="s.photo_url" (input)="setField(s.id, 'photo_url', $any($event.target).value)" placeholder="https://… or /uploads/…" class="w-full min-w-0 rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none" />
                </div>
              </label>

              <div class="flex flex-wrap items-center gap-x-6 gap-y-3">
                <label class="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" class="size-4 accent-cerulean" [checked]="s.available" (change)="setField(s.id, 'available', $any($event.target).checked)" />
                  <span class="font-sans text-body-sm text-ink">Available for booking</span>
                </label>
                <label class="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" class="size-4 accent-cerulean" [checked]="s.verified" (change)="setField(s.id, 'verified', $any($event.target).checked)" />
                  <span class="font-sans text-body-sm text-ink">Verified</span>
                </label>
                @if (s.status !== 'approved') {
                  <span class="font-sans text-caption text-slate">Not listed or bookable until approved.</span>
                }
              </div>

              @if (s.inviteNotice) {
                <div class="flex flex-col gap-1 rounded-field bg-sage/10 px-4 py-2 font-sans text-caption text-sage">
                  <span>{{ s.inviteNotice }}</span>
                  @if (s.devLink) {
                    <span class="break-all text-slate">Testing only — set-password link: <span class="select-all font-mono text-ink">{{ s.devLink }}</span></span>
                  }
                </div>
              }
              @if (s.error) {
                <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">{{ s.error }}</p>
              }
            </li>
          } @empty {
            <li class="rounded-card border border-cloud bg-white px-5 py-12 text-center font-sans text-body-sm text-slate">No specialists here.</li>
          }
        </ul>
      }
    </div>

    @if (createOpen()) {
      <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="createOpen.set(false)"></button>
        <div class="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-[16px] bg-white p-6 shadow-[0_8px_40px_rgba(10,22,40,0.2)]">
          <div class="flex items-center justify-between">
            <h3 class="font-heading text-h5 text-ink">New specialist</h3>
            <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="createOpen.set(false)"><sd-icon name="x" [size]="22" /></button>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Full name *</span>
              <input type="text" [value]="draft().name" (input)="setDraft('name', $any($event.target).value)" placeholder="Dr Jane Doe" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Speciality *</span>
              <input type="text" [value]="draft().specialty" (input)="setDraft('specialty', $any($event.target).value)" placeholder="Cardiology" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Contact email</span>
              <input type="email" [value]="draft().email" (input)="setDraft('email', $any($event.target).value)" placeholder="doctor@example.com" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Consultation fee (₦)</span>
              <input type="number" min="0" step="500" [value]="draft().consultation_fee" (input)="setDraft('consultation_fee', $any($event.target).value)" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Location</span>
              <input type="text" [value]="draft().location" (input)="setDraft('location', $any($event.target).value)" placeholder="Lagos, Nigeria" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Years of experience</span>
              <input type="number" min="0" [value]="draft().years_experience" (input)="setDraft('years_experience', $any($event.target).value)" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" />
            </label>
          </div>

          <label class="flex flex-col gap-1.5">
            <span class="font-sans text-caption font-semibold text-slate">Short bio</span>
            <textarea rows="3" [value]="draft().bio" (input)="setDraft('bio', $any($event.target).value)" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"></textarea>
          </label>

          <div class="flex flex-wrap items-center gap-6">
            <label class="flex cursor-pointer items-center gap-2">
              <input type="checkbox" class="size-4 accent-cerulean" [checked]="draft().available" (change)="setDraft('available', $any($event.target).checked)" />
              <span class="font-sans text-body-sm text-ink">Available for booking</span>
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input type="checkbox" class="size-4 accent-cerulean" [checked]="draft().verified" (change)="setDraft('verified', $any($event.target).checked)" />
              <span class="font-sans text-body-sm text-ink">Verified</span>
            </label>
          </div>

          <p class="font-sans text-caption text-slate">
            New specialists aren't listed until they've been invited, completed their profile and been approved here.
          </p>

          @if (createError()) {
            <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">{{ createError() }}</p>
          }

          <div class="flex justify-end gap-3">
            <button type="button" class="rounded-field border border-cloud px-4 py-2.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:bg-glacier" (click)="createOpen.set(false)">Cancel</button>
            <button type="button" class="rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="creating()" (click)="submitCreate()">{{ creating() ? 'Creating…' : 'Create specialist' }}</button>
          </div>
        </div>
      </div>
    }

    <!-- Onboarding review panel -->
    @if (reviewRow(); as r) {
      <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="closeReview()"></button>
        <div class="relative z-10 flex max-h-[90vh] w-full max-w-2xl flex-col gap-5 overflow-y-auto rounded-[16px] bg-white p-5 shadow-[0_8px_40px_rgba(10,22,40,0.2)] sm:p-6" role="dialog" aria-modal="true" aria-labelledby="review-title">
          <div class="flex items-start justify-between gap-3">
            <div class="flex min-w-0 flex-col gap-1">
              <h3 id="review-title" class="break-words font-heading text-h5 text-ink">{{ r.name }}</h3>
              <span class="font-sans text-caption text-cerulean">{{ r.specialty }}</span>
            </div>
            <button type="button" class="shrink-0 text-slate transition-colors hover:text-ink" aria-label="Close" (click)="closeReview()"><sd-icon name="x" [size]="22" /></button>
          </div>

          @if (reviewLoading()) {
            <div class="sd-shimmer h-64 rounded-card"></div>
          } @else if (reviewLoadError()) {
            <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">{{ reviewLoadError() }}</p>
          } @else if (review(); as v) {
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold" [class]="statusBadge(r).cls">{{ statusBadge(r).label }}</span>
              <span class="rounded-pill px-2.5 py-0.5 font-sans text-caption" [class]="loginBadge(r).cls">{{ loginBadge(r).label }}</span>
              @if (v.submitted_at) {
                <span class="font-sans text-caption text-slate">Submitted {{ date(v.submitted_at) }}</span>
              }
              @if (v.approved_at) {
                <span class="font-sans text-caption text-slate">· Approved {{ date(v.approved_at) }}</span>
              }
            </div>

            @if (v.status === 'rejected' && v.rejection_reason) {
              <div class="rounded-field bg-warning/10 px-4 py-3 font-sans text-body-sm text-ink">
                <span class="block font-semibold">Sent back with:</span>
                <span class="whitespace-pre-line break-words">{{ v.rejection_reason }}</span>
              </div>
            }

            <!-- Checklist -->
            <section class="flex flex-col gap-2">
              <div class="flex items-center justify-between gap-2">
                <h4 class="font-heading text-body font-semibold text-ink">Onboarding checklist</h4>
                <span class="font-sans text-caption font-semibold text-slate">{{ v.completed }} of {{ v.total }} done</span>
              </div>
              <ul class="grid gap-1.5 sm:grid-cols-2">
                @for (c of checklist; track c.key) {
                  <li class="flex items-center gap-2 font-sans text-body-sm" [class]="v.checklist[c.key] ? 'text-ink' : 'text-slate'">
                    <sd-icon [name]="v.checklist[c.key] ? 'circle-check' : 'circle-x'" [size]="16" [class]="v.checklist[c.key] ? 'text-sage' : 'text-alert'" />
                    {{ c.label }}
                  </li>
                }
              </ul>
            </section>

            <!-- What the doctor submitted -->
            <section class="flex flex-col gap-3 rounded-card border border-cloud p-4">
              <div class="flex items-center gap-3">
                @if (photoSrc(v.profile.photo_url ?? ''); as src) {
                  <img [src]="src" [alt]="r.name" class="size-14 shrink-0 rounded-full border border-cloud object-cover" />
                } @else {
                  <span class="flex size-14 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-sans text-body-sm font-semibold text-cerulean">{{ initials(r.name) }}</span>
                }
                <dl class="grid min-w-0 flex-1 grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-sans text-caption">
                  <dt class="text-slate">MDCN</dt>
                  <dd class="break-all text-ink">{{ v.profile.mdcn_number || '—' }}</dd>
                  <dt class="text-slate">Signature</dt>
                  <dd class="text-ink">{{ v.profile.has_signature ? 'Saved' : 'Not saved' }}</dd>
                  <dt class="text-slate">Email</dt>
                  <dd class="break-all text-ink">{{ v.profile.email || '—' }}</dd>
                </dl>
              </div>
              <div class="flex flex-col gap-1">
                <span class="font-sans text-caption font-semibold text-slate">Bio</span>
                <p class="whitespace-pre-line break-words font-sans text-body-sm text-ink">{{ v.profile.bio || '—' }}</p>
              </div>
              <div class="flex flex-col gap-1">
                <span class="font-sans text-caption font-semibold text-slate">Qualifications</span>
                @if (v.profile.qualifications) {
                  <p class="break-words font-sans text-body-sm text-ink">{{ v.profile.qualifications }}</p>
                }
                @for (q of v.profile.qualification_entries ?? []; track $index) {
                  <p class="break-words font-sans text-body-sm text-ink">{{ q.title }}{{ q.institution ? ' · ' + q.institution : '' }}{{ q.year ? ' (' + q.year + ')' : '' }}</p>
                }
                @if (!v.profile.qualifications && !(v.profile.qualification_entries ?? []).length) {
                  <p class="font-sans text-body-sm text-slate">—</p>
                }
              </div>
              <div class="flex flex-col gap-1">
                <span class="font-sans text-caption font-semibold text-slate">Weekly hours</span>
                <p class="break-words font-sans text-body-sm text-ink">{{ hoursSummary(v) }}</p>
              </div>
            </section>

            <!-- Decision -->
            @if (v.status === 'pending_review' || v.status === 'suspended') {
              <section class="flex flex-col gap-3 border-t border-cloud pt-4">
                <button type="button" class="flex w-full items-center justify-center gap-2 rounded-field bg-sage px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:brightness-95 disabled:opacity-60 sm:w-fit" [disabled]="deciding() !== ''" (click)="approve(r.id)">
                  <sd-icon name="badge-check" [size]="18" />{{ deciding() === 'approve' ? 'Approving…' : (v.status === 'suspended' ? 'Reinstate doctor' : 'Approve doctor') }}
                </button>
                @if (v.status === 'pending_review') {
                  <label class="flex flex-col gap-1.5">
                    <span class="font-sans text-caption font-semibold text-slate">Or send it back — tell the doctor what to change</span>
                    <textarea rows="3" maxlength="2000" [value]="rejectReason()" (input)="rejectReason.set($any($event.target).value)" placeholder="e.g. Please upload a clearer, professional headshot." class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"></textarea>
                  </label>
                  <button type="button" class="flex w-full items-center justify-center gap-2 rounded-field border border-alert/40 px-5 py-2.5 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5 disabled:opacity-60 sm:w-fit" [disabled]="deciding() !== ''" (click)="reject(r.id)">
                    <sd-icon name="undo-2" [size]="18" />{{ deciding() === 'reject' ? 'Sending…' : 'Send back to doctor' }}
                  </button>
                }
              </section>
            } @else if (v.status === 'approved') {
              <p class="rounded-field bg-sage/10 px-4 py-2 font-sans text-body-sm text-sage">This doctor is approved and listed for patients.</p>
            } @else {
              <p class="rounded-field bg-glacier px-4 py-2 font-sans text-body-sm text-slate">Approve or send back becomes available once the doctor submits their profile for review.</p>
            }

            @if (decisionError()) {
              <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">{{ decisionError() }}</p>
            }
          }
        </div>
      </div>
    }
  `,
})
export class AdminSpecialists implements OnInit {
  private readonly api = inject(SpecialistsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly reviewQueue = inject(ReviewQueue);

  protected readonly checklist = CHECKLIST;
  protected readonly loading = signal(true);
  protected readonly listError = signal('');
  protected readonly specialists = signal<Row[]>([]);
  protected readonly filter = signal<Filter>('all');

  // Onboarding modal
  protected readonly createOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly createError = signal('');
  protected readonly draft = signal<Draft>({ ...EMPTY_DRAFT });

  // Review panel
  private readonly reviewId = signal<string | null>(null);
  protected readonly reviewRow = computed(() => {
    const id = this.reviewId();
    return id ? (this.specialists().find((s) => s.id === id) ?? null) : null;
  });
  protected readonly review = signal<SpecialistOnboardingReviewDto | null>(null);
  protected readonly reviewLoading = signal(false);
  protected readonly reviewLoadError = signal('');
  protected readonly rejectReason = signal('');
  protected readonly deciding = signal<'' | 'approve' | 'reject'>('');
  protected readonly decisionError = signal('');

  protected readonly filters = computed(() => {
    const list = this.specialists();
    const count = (f: Filter) => list.filter((s) => this.matches(s, f)).length;
    return [
      { value: 'all' as Filter, label: 'All', count: list.length },
      { value: 'review' as Filter, label: 'Needs review', count: count('review') },
      { value: 'onboarding' as Filter, label: 'Onboarding', count: count('onboarding') },
      { value: 'approved' as Filter, label: 'Approved', count: count('approved') },
    ];
  });
  protected readonly visible = computed(() =>
    this.specialists().filter((s) => this.matches(s, this.filter())),
  );

  constructor() {
    // Keep the nav's "Needs review" badge in step with this list (loads, approvals, send-backs).
    effect(() => {
      if (this.loading() || this.listError()) return;
      this.reviewQueue.set(this.specialists().filter((s) => this.matches(s, 'review')).length);
    });
  }

  ngOnInit(): void {
    // `?filter=review` — the link in the "doctor ready for review" email.
    const wanted = this.route.snapshot.queryParamMap.get('filter') as Filter | null;
    if (wanted && FILTERS.includes(wanted)) this.filter.set(wanted);

    this.api
      .listAdmin()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.specialists.set(res.data.map((s) => this.toRow(s)));
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.listError.set(apiErrorMessage(err, 'Could not load specialists.'));
          this.loading.set(false);
        },
      });
  }

  private toRow(s: SpecialistAdminDto): Row {
    return {
      id: s.id,
      name: s.name,
      specialty: s.specialty,
      email: s.email ?? '',
      savedEmail: s.email ?? '',
      consultation_fee: String(s.consultation_fee ?? ''),
      photo_url: s.photo_url ?? '',
      available: !!s.available,
      verified: !!s.verified,
      // A payload without a status is a doctor from before onboarding: approved.
      status: s.status ?? 'approved',
      login: s.login ?? null,
      saving: false,
      saved: false,
      error: '',
      inviting: false,
      inviteNotice: '',
      devLink: '',
    };
  }

  private matches(s: Row, f: Filter): boolean {
    switch (f) {
      case 'review':
        return s.status === 'pending_review';
      case 'onboarding':
        return s.status === 'invited' || s.status === 'rejected';
      case 'approved':
        return s.status === 'approved';
      default:
        return true;
    }
  }

  protected statusBadge(s: Row): Badge {
    switch (s.status) {
      case 'approved':
        return { label: 'Approved', cls: 'bg-sage/15 text-sage' };
      case 'pending_review':
        return { label: 'Needs review', cls: 'bg-warning/15 text-ink' };
      case 'rejected':
        return { label: 'Changes requested', cls: 'bg-alert/10 text-alert' };
      case 'suspended':
        return { label: 'Suspended', cls: 'bg-cloud text-slate' };
      default:
        return { label: 'Onboarding', cls: 'bg-frost text-cerulean' };
    }
  }

  protected loginBadge(s: Row): Badge {
    const l = s.login;
    if (!l) return { label: 'No login yet', cls: 'bg-glacier text-slate' };
    if (!l.active) return { label: 'Login deactivated', cls: 'bg-cloud text-slate' };
    if (l.password_set) return { label: 'Login active', cls: 'bg-glacier text-ink' };
    if (l.invite_pending) {
      return {
        label: 'Invite sent' + (l.invite_expires_at ? ` · expires ${this.date(l.invite_expires_at)}` : ''),
        cls: 'bg-frost text-cerulean',
      };
    }
    return { label: 'Invite expired', cls: 'bg-warning/15 text-ink' };
  }

  /** Invite until the doctor has chosen a password (an active login needs none). */
  protected canInvite(s: Row): boolean {
    return !s.login || (s.login.active && !s.login.password_set);
  }

  /**
   * Why the invite can't go yet ('' when it can). A resend always goes to the
   * existing login's email; a first invite uses the saved contact email.
   */
  protected inviteHint(s: Row): string {
    if (s.login) return '';
    // Same rule as the API: a live doctor's login is never created from the contact email here.
    if (s.status === 'approved' || s.status === 'suspended') {
      return 'This doctor is already live, so their login has to be created from Staff & roles.';
    }
    if (!s.savedEmail && !s.email.trim()) return "Add the doctor's email, save, then send the invite.";
    if (s.email.trim() !== s.savedEmail) return 'Save the new email before sending the invite.';
    return '';
  }

  protected setField(id: string, key: 'email' | 'consultation_fee' | 'photo_url' | 'available' | 'verified', value: string | boolean): void {
    this.specialists.update((list) => list.map((s) => (s.id === id ? { ...s, [key]: value, saved: false, error: '' } : s)));
  }

  private patch(id: string, patch: Partial<Row>): void {
    this.specialists.update((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  protected save(id: string): void {
    const row = this.specialists().find((s) => s.id === id);
    if (!row) return;
    this.patch(id, { saving: true, error: '', saved: false });
    this.api
      .update(id, {
        email: row.email.trim(),
        consultation_fee: row.consultation_fee,
        photo_url: row.photo_url.trim(),
        available: row.available,
        verified: row.verified,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const d = res.data;
          this.patch(id, {
            saving: false,
            saved: true,
            email: d.email ?? row.email,
            savedEmail: d.email ?? '',
            consultation_fee: String(d.consultation_fee ?? row.consultation_fee),
            photo_url: d.photo_url ?? row.photo_url,
          });
        },
        error: (err: unknown) => this.patch(id, { saving: false, error: apiErrorMessage(err, 'Could not save.') }),
      });
  }

  protected invite(id: string): void {
    const row = this.specialists().find((s) => s.id === id);
    if (!row || this.inviteHint(row)) return;
    this.patch(id, { inviting: true, error: '', inviteNotice: '', devLink: '' });
    this.api
      .invite(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const d = res.data;
          // The invite goes to the login's email — the sign-in email.
          const to = d.login?.email ?? row.savedEmail;
          this.patch(id, {
            inviting: false,
            login: d.login ?? row.login,
            inviteNotice: d.email_sent
              ? `Invite sent to ${to}. The link expires in 7 days.`
              : `The invite link was created, but the email to ${to} could not be sent. Try "Resend invite" shortly.`,
            devLink: d.dev_link ?? '',
          });
        },
        error: (err: unknown) => this.patch(id, { inviting: false, error: apiErrorMessage(err, 'Could not send the invite.') }),
      });
  }

  protected openReview(s: Row): void {
    this.reviewId.set(s.id);
    this.review.set(null);
    this.rejectReason.set('');
    this.decisionError.set('');
    this.reviewLoadError.set('');
    this.reviewLoading.set(true);
    this.api
      .onboardingReview(s.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.review.set(res.data);
          this.patch(s.id, { status: res.data.status, login: res.data.login });
          this.reviewLoading.set(false);
        },
        error: (err: unknown) => {
          this.reviewLoadError.set(apiErrorMessage(err, 'Could not load this onboarding review.'));
          this.reviewLoading.set(false);
        },
      });
  }

  protected closeReview(): void {
    this.reviewId.set(null);
  }

  protected approve(id: string): void {
    this.deciding.set('approve');
    this.decisionError.set('');
    this.api
      .approve(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.applyDecision(id, res.data);
          this.patch(id, { verified: true });
        },
        error: (err: unknown) => {
          this.deciding.set('');
          this.decisionError.set(apiErrorMessage(err, 'Could not approve this doctor.'));
        },
      });
  }

  protected reject(id: string): void {
    const reason = this.rejectReason().trim();
    if (!reason) {
      this.decisionError.set('Tell the doctor what to change before sending it back.');
      return;
    }
    this.deciding.set('reject');
    this.decisionError.set('');
    this.api
      .reject(id, reason)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.applyDecision(id, res.data),
        error: (err: unknown) => {
          this.deciding.set('');
          this.decisionError.set(apiErrorMessage(err, 'Could not send this profile back.'));
        },
      });
  }

  /** Reflect a decision in both the panel and the list. */
  private applyDecision(id: string, summary: DoctorOnboardingDto): void {
    this.deciding.set('');
    this.rejectReason.set('');
    this.review.update((v) => (v ? { ...v, ...summary } : v));
    this.patch(id, { status: summary.status });
  }

  protected hoursSummary(v: SpecialistOnboardingReviewDto): string {
    const hours = v.profile.weekly_hours ?? {};
    const parts = Object.keys(hours)
      .sort()
      .filter((d) => (hours[d] ?? []).length > 0)
      .map((d) => `${WEEKDAYS[Number(d)] ?? d} ${hours[d].map(([a, b]) => `${a}–${b}`).join(', ')}`);
    if (parts.length) return parts.join(' · ');
    return v.checklist.availability ? 'No weekly hours — uses published open slots.' : 'Not set yet.';
  }

  protected openCreate(): void {
    this.draft.set({ ...EMPTY_DRAFT });
    this.createError.set('');
    this.createOpen.set(true);
  }

  protected setDraft(key: keyof Draft, value: string | boolean): void {
    this.draft.update((d) => ({ ...d, [key]: value }));
  }

  protected submitCreate(): void {
    const d = this.draft();
    if (d.name.trim() === '' || d.specialty.trim() === '') {
      this.createError.set('Name and speciality are required.');
      return;
    }
    this.creating.set(true);
    this.createError.set('');
    const params: CreateSpecialistParams = {
      name: d.name.trim(),
      specialty: d.specialty.trim(),
      email: d.email.trim() || undefined,
      consultation_fee: d.consultation_fee.trim() || undefined,
      location: d.location.trim() || undefined,
      years_experience: d.years_experience.trim() || undefined,
      bio: d.bio.trim() || undefined,
      available: d.available,
      verified: d.verified,
    };
    this.api
      .createAdmin(params)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.specialists.update((list) => [this.toRow(res.data), ...list]);
          this.creating.set(false);
          this.createOpen.set(false);
        },
        error: (err: unknown) => {
          this.creating.set(false);
          this.createError.set(apiErrorMessage(err, 'Could not create the specialist.'));
        },
      });
  }

  protected photoSrc(url: string): string | null {
    return this.api.assetUrl(url.trim() || null);
  }
  protected initials(name: string): string {
    return name.replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }
  protected date(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }
}
