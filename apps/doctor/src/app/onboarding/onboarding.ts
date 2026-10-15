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
import { RouterLink } from '@angular/router';
import { apiErrorMessage, DoctorApi, todayLocal } from '@supadoc/data-access';
import type { CredentialType, DoctorOnboardingDto, OnboardingItemKey, SpecialistCredentialDto } from '@supadoc/models';
import { AlertComponent, ButtonComponent, IconComponent } from '@supadoc/ui';
import { DoctorStandingStore } from '../standing/doctor-standing.store';
import {
  changedFieldsLabel,
  daysUntil,
  inDaysLabel,
  latestCredential,
  licenceDocuments,
  renewalText,
  ymdLabel,
} from '../standing/standing-rules';
import { CredentialStatusChip } from './credential-status';

interface ChecklistItem {
  readonly key: OnboardingItemKey;
  readonly label: string;
  readonly hint: string;
  readonly icon: string;
  readonly link: string;
  /** A licensing document: its review state shows as a chip. */
  readonly document?: CredentialType;
}

/** The steps, in order (the API's), and where each one is completed. */
const ITEMS: readonly ChecklistItem[] = [
  { key: 'photo', label: 'Profile photo', hint: 'A clear, professional headshot patients will see.', icon: 'camera', link: '/profile' },
  { key: 'bio', label: 'About you', hint: 'A short bio for your public profile.', icon: 'file-text', link: '/profile' },
  { key: 'qualifications', label: 'Qualifications', hint: 'Your degrees and specialist training.', icon: 'graduation-cap', link: '/profile' },
  { key: 'mdcn', label: 'MDCN registration number', hint: 'Printed on every prescription you send.', icon: 'id-card', link: '/profile' },
  {
    key: 'mdcn_certificate',
    label: 'MDCN full-registration certificate',
    hint: 'A copy of your certificate, verified against the MDCN register.',
    icon: 'file-check',
    link: '/onboarding/credentials',
    document: 'mdcn_full_registration',
  },
  {
    key: 'practising_licence',
    label: 'Annual practising licence',
    hint: 'Your current APL, with its number and expiry date.',
    icon: 'badge-check',
    link: '/onboarding/credentials',
    document: 'annual_practising_licence',
  },
  { key: 'signature', label: 'Signature', hint: 'Used to sign your prescriptions.', icon: 'signature', link: '/profile' },
  { key: 'availability', label: 'Availability', hint: 'Weekly hours or open slots patients can book.', icon: 'calendar-clock', link: '/availability' },
  { key: 'payout', label: 'Payout account', hint: 'Where your consultation earnings are paid.', icon: 'wallet', link: '/payouts' },
  { key: 'terms', label: 'Practitioner terms', hint: 'Read and accept the terms for consulting on VideoMed.', icon: 'scroll-text', link: '/onboarding/terms' },
];

/**
 * Onboarding (route `/onboarding`): the checklist a new doctor works through
 * (each step links to the page where it's done; the documents show their
 * review state and a reviewer's reason for turning one down), progress,
 * "Submit for review" and the review outcome. Once approved it is the
 * account's status page too: a suspension and its reason, the licence, the
 * terms in force and a change request waiting for review. Profile,
 * availability, payouts, documents and terms stay reachable throughout.
 */
@Component({
  selector: 'doc-onboarding',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AlertComponent, ButtonComponent, CredentialStatusChip, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex max-w-3xl flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">{{ live() ? 'Your account' : 'Get set up on VideoMed' }}</h1>
        <p class="font-sans text-body text-slate">
          @if (live()) {
            Your profile checklist, licensing documents and practitioner terms.
          } @else {
            Complete each step, then submit your profile for review. Patients can find and book you once it's approved.
          }
        </p>
      </header>

      @if (loading()) {
        <div class="sd-shimmer h-16 rounded-card"></div>
        <div class="sd-shimmer h-96 rounded-card"></div>
      } @else if (loadError()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white px-5 py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ loadError() }}</p>
          <sd-button variant="outline" size="sm" (click)="load()">
            <sd-icon name="refresh-cw" [size]="16" />Try again
          </sd-button>
        </div>
      } @else if (data(); as d) {
        <!-- Where the review stands -->
        @switch (d.status) {
          @case ('pending_review') {
            <sd-alert tone="info">
              <span class="font-semibold">Your profile is with our team for review.</span>
              We'll email you as soon as it's approved{{ d.submitted_at ? ' (submitted ' + date(d.submitted_at) + ')' : '' }}. You can keep updating your details in the meantime.
            </sd-alert>
          }
          @case ('rejected') {
            <sd-alert tone="warning">
              <span class="block font-semibold">Your profile needs a few changes before it can be approved.</span>
              @if (d.rejection_reason) {
                <span class="mt-1 block whitespace-pre-line break-words text-ink">{{ d.rejection_reason }}</span>
              }
              <span class="mt-1 block">Make the changes below, then submit your profile again.</span>
            </sd-alert>
          }
          @case ('approved') {
            <sd-alert tone="success">
              <span class="font-semibold">You're approved.</span>
              Patients can find you in the directory and book the times you've made available.
              <a routerLink="/dashboard" class="font-semibold underline">Go to your dashboard</a>
            </sd-alert>
          }
          @case ('suspended') {
            <div class="flex flex-col gap-3 rounded-card border border-alert/30 bg-white p-5" role="alert">
              <p class="flex items-start gap-2 font-sans text-body-sm text-ink">
                <sd-icon name="ban" [size]="20" class="mt-0.5 shrink-0 text-alert" />
                <span>
                  <span class="block font-semibold">Your account is suspended{{ d.suspension?.suspended_at ? ' since ' + date(d.suspension.suspended_at) : '' }}.</span>
                  Patients can't book you, and clinical work is closed.
                </span>
              </p>
              @if (d.suspension; as s) {
                <dl class="flex flex-col gap-1 rounded-field bg-alert/5 px-4 py-3">
                  <dt class="font-sans text-caption font-semibold text-slate">Reason</dt>
                  <dd class="font-sans text-body-sm text-ink">{{ s.code_label }}</dd>
                  @if (s.reason) {
                    <dt class="mt-1 font-sans text-caption font-semibold text-slate">Details</dt>
                    <dd class="whitespace-pre-line break-words font-sans text-body-sm text-ink">{{ s.reason }}</dd>
                  }
                </dl>
              }
              <a routerLink="/account-status" class="inline-flex min-h-11 w-fit items-center gap-1 font-sans text-body-sm font-semibold text-cerulean hover:text-ocean">
                What this means and what to do next<sd-icon name="chevron-right" [size]="16" />
              </a>
            </div>
          }
        }

        <!-- An approved doctor: the terms in force, the licence, a change request -->
        @if (live() && !d.terms.accepted) {
          <sd-alert tone="warning">
            <span class="block font-semibold">{{ d.terms.accepted_version ? 'The practitioner terms have been updated to version ' + d.terms.current_version + '.' : 'Accept the practitioner terms.' }}</span>
            Until you accept them you can't join calls or write clinical records.
            <a routerLink="/onboarding/terms" class="font-semibold underline">Read and accept</a>
          </sd-alert>
        }
        @if (licenceText(); as l) {
          <sd-alert [tone]="l.tone">
            {{ l.text }}
            <a routerLink="/onboarding/credentials" class="font-semibold underline">{{ l.cta }}</a>
          </sd-alert>
        }
        @if (d.pending_changes) {
          <sd-alert tone="info">
            <span class="block font-semibold">Your change to {{ pendingLabel() }} is waiting for review{{ d.pending_changes_submitted_at ? ' (sent ' + date(d.pending_changes_submitted_at) + ')' : '' }}.</span>
            Patients and prescriptions show your current details until a reviewer approves it.
            <a routerLink="/profile" class="font-semibold underline">View or withdraw it</a>
          </sd-alert>
        } @else if (d.changes_review_note && live()) {
          <sd-alert tone="warning">
            <span class="block font-semibold">Your last change request wasn't approved.</span>
            <span class="block whitespace-pre-line break-words text-ink">{{ d.changes_review_note }}</span>
          </sd-alert>
        }

        <section class="flex flex-col rounded-card border border-cloud bg-white">
          <div class="flex flex-col gap-3 border-b border-cloud px-4 py-4 sm:px-5">
            <div class="flex items-center justify-between gap-3">
              <h2 class="flex items-center gap-2 font-heading text-body-lg text-ink">
                <sd-icon name="list-checks" [size]="20" class="text-cerulean" />Your checklist
              </h2>
              <span class="shrink-0 font-sans text-body-sm font-semibold text-slate">{{ d.completed }} of {{ d.total }} done</span>
            </div>
            <div
              class="h-2 w-full overflow-hidden rounded-pill bg-cloud"
              role="progressbar"
              aria-label="Onboarding progress"
              [attr.aria-valuenow]="d.completed"
              aria-valuemin="0"
              [attr.aria-valuemax]="d.total"
            >
              <div class="h-full rounded-pill bg-sage transition-[width] duration-500" [style.width.%]="percent()"></div>
            </div>
          </div>

          <ul class="flex flex-col divide-y divide-cloud">
            @for (item of items; track item.key) {
              @let done = d.checklist[item.key];
              @let doc = item.document ? document(d, item.document) : null;
              <li class="flex flex-col gap-2 px-4 py-3.5 sm:px-5">
                <div class="flex items-center gap-3">
                  <span
                    class="flex size-10 shrink-0 items-center justify-center rounded-full"
                    [class]="done ? 'bg-sage/15 text-sage' : 'bg-frost text-cerulean'"
                  >
                    <sd-icon [name]="done ? 'circle-check' : item.icon" [size]="20" />
                  </span>
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <span class="font-sans text-body-sm font-semibold text-ink">
                      {{ item.label }}<span class="sr-only">{{ done ? ' — done' : ' — to do' }}</span>
                    </span>
                    <span class="font-sans text-caption text-slate">{{ itemHint(item, d) }}</span>
                    @if (item.document) {
                      <doc-credential-status [status]="doc?.status ?? 'missing'" />
                    }
                    @if (item.document === 'annual_practising_licence') {
                      @if (licenceDocuments(d.credentials, d.licence).renewal; as r) {
                        <!-- A renewal beside the licence in force: said on its own line. -->
                        <span class="flex items-start gap-1.5 font-sans text-caption" [class]="r.status === 'rejected' ? 'text-alert' : 'text-slate'">
                          <sd-icon [name]="r.status === 'rejected' ? 'circle-x' : 'hourglass'" [size]="13" class="mt-0.5 shrink-0" />
                          <span class="min-w-0 whitespace-pre-line break-words">{{ renewalText(r) }}</span>
                        </span>
                      }
                    }
                  </div>
                  @if (done) {
                    <a
                      [routerLink]="item.link"
                      class="flex min-h-11 shrink-0 items-center rounded-field px-2 font-sans text-caption font-semibold text-slate transition-colors hover:text-cerulean"
                      [attr.aria-label]="(item.key === 'terms' ? 'Read ' : 'Edit ') + item.label"
                      >{{ item.key === 'terms' ? 'Read' : 'Edit' }}</a
                    >
                  } @else {
                    <a
                      [routerLink]="item.link"
                      class="flex min-h-11 shrink-0 items-center gap-1 rounded-field border border-cloud px-3 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean"
                      [attr.aria-label]="actionLabel(item, doc) + ' ' + item.label"
                      >{{ actionLabel(item, doc) }} <sd-icon name="chevron-right" [size]="14"
                    /></a>
                  }
                </div>
                @if (doc?.status === 'rejected' && doc?.rejection_reason) {
                  <p class="ml-[3.25rem] whitespace-pre-line break-words rounded-field bg-alert/10 px-3 py-2 font-sans text-caption text-alert">
                    <span class="font-semibold">Reviewer's note:</span> {{ doc?.rejection_reason }}
                  </p>
                }
              </li>
            }
          </ul>
        </section>

        @if (canSubmit()) {
          <section class="flex flex-col gap-4 rounded-card bg-frost/60 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div class="flex items-start gap-3">
              <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-white text-cerulean shadow-sm">
                <sd-icon name="send" [size]="20" />
              </span>
              <div class="flex min-w-0 flex-col">
                <p class="font-heading text-body-lg text-ink">
                  {{ d.status === 'rejected' ? 'Submit your changes' : 'Ready when you are' }}
                </p>
                <p class="font-sans text-body-sm text-slate">
                  {{ d.complete ? 'An admin will review your profile and verify your documents, usually within a few working days.' : 'Complete every step above to submit your profile for review.' }}
                </p>
              </div>
            </div>
            <sd-button class="shrink-0" [disabled]="!d.complete || submitting()" (click)="submit()">
              {{ submitting() ? 'Submitting…' : 'Submit for review' }}
            </sd-button>
          </section>
        }
        @if (submitError()) {
          <sd-alert tone="error">{{ submitError() }}</sd-alert>
        }
      }
    </div>
  `,
})
export class DoctorOnboarding implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly standing = inject(DoctorStandingStore);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly items = ITEMS;
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly data = signal<DoctorOnboardingDto | null>(null);
  protected readonly submitting = signal(false);
  protected readonly submitError = signal('');

  protected readonly percent = computed(() => {
    const d = this.data();
    return d && d.total > 0 ? Math.round((d.completed / d.total) * 100) : 0;
  });
  /** Submitting is for a profile still being set up, or one sent back. */
  protected readonly canSubmit = computed(() => {
    const s = this.data()?.status;
    return s === 'invited' || s === 'rejected';
  });
  /** Approved (or suspended): past onboarding — this page is their account's status. */
  protected readonly live = computed(() => {
    const s = this.data()?.status;
    return s === 'approved' || s === 'suspended';
  });
  protected readonly pendingLabel = computed(() => changedFieldsLabel(Object.keys(this.data()?.pending_changes ?? {})));
  /** The current licence running out, or gone (approved doctors; a suspension already explains itself). */
  protected readonly licenceText = computed<{ tone: 'warning' | 'error'; text: string; cta: string } | null>(() => {
    const d = this.data();
    const l = d?.licence;
    if (!d || d.status !== 'approved' || !l?.expires_at) return null;
    if (l.status === 'expired') {
      return { tone: 'error', text: `Your practising licence expired on ${ymdLabel(l.expires_at)}.`, cta: 'Upload your renewed licence' };
    }
    if (l.status === 'expiring') {
      const days = daysUntil(l.expires_at, todayLocal());
      return {
        tone: 'warning',
        text: `Your practising licence expires ${inDaysLabel(days)} (${ymdLabel(l.expires_at)}).`,
        cta: 'Upload the renewal',
      };
    }
    return null;
  });

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.api
      .onboarding()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          this.standing.set(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loadError.set(apiErrorMessage(err, 'Could not load your onboarding checklist.'));
          this.loading.set(false);
        },
      });
  }

  protected submit(): void {
    this.submitting.set(true);
    this.submitError.set('');
    this.api
      .submitOnboarding()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          this.standing.set(res.data);
          this.submitting.set(false);
        },
        error: (err: unknown) => {
          this.submitError.set(apiErrorMessage(err, 'Could not submit your profile. Please try again.'));
          this.submitting.set(false);
        },
      });
  }

  protected readonly licenceDocuments = licenceDocuments;
  protected readonly renewalText = renewalText;

  /** The document a step shows — for the licence, the one in force (a renewal has its own line). */
  protected document(d: DoctorOnboardingDto, type: CredentialType): SpecialistCredentialDto | null {
    if (type === 'annual_practising_licence') return licenceDocuments(d.credentials, d.licence).current;
    return latestCredential(d.credentials, type);
  }

  /** A document's hint says what is on file; others keep their own. */
  protected itemHint(item: ChecklistItem, d: DoctorOnboardingDto): string {
    if (item.key === 'practising_licence') {
      const doc = this.document(d, 'annual_practising_licence');
      if (doc?.expires_at && doc.status !== 'rejected') {
        const until = doc.status === 'verified' ? 'valid until' : 'expires';
        return `${doc.number ? 'No. ' + doc.number + ' · ' : ''}${until} ${ymdLabel(doc.expires_at)}.`;
      }
    }
    if (item.key === 'terms' && d.terms.accepted && d.terms.accepted_at) {
      return `Version ${d.terms.accepted_version} accepted on ${this.date(d.terms.accepted_at)}.`;
    }
    return item.hint;
  }

  /** Add / Replace / Upload / Accept — what the link does for a step still to do. */
  protected actionLabel(item: ChecklistItem, doc: SpecialistCredentialDto | null): string {
    if (item.key === 'terms') return 'Accept';
    if (item.document) return doc ? 'Replace' : 'Upload';
    return 'Add';
  }

  protected date(iso: string | null | undefined): string {
    if (!iso) return '';
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }
}
