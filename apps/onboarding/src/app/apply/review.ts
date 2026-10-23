import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { CanLeave } from '@supadoc/auth';
import type {
  ApplicationDocumentSlot,
  ApplicationDraftDto,
  ApplicationStepKey,
} from '@supadoc/models';
import { AlertComponent, DialogService, IconComponent, warnBeforeUnload, WORLD_COUNTRIES } from '@supadoc/ui';
import { Announcer } from '../core/announcer';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { DOCUMENT_STEP_SLOTS, licenceSlot, slotCopy } from '../core/documents';
import { apiErrorCode, bannerMessage, DRAFT_ENDED } from '../core/errors';
import { formatDateLong, formatPhone } from '../core/format';
import { NOTICE, Notices } from '../core/notices';
import { OnboardingConfigStore } from '../core/onboarding-config.store';
import { documentInSlot } from '../core/step-source';
import { STEPS, stepTitle, stepUrl } from '../core/wizard-steps';
import { CancelDialogComponent } from '../shared/cancel-dialog';
import { ConfirmEmailDialogComponent } from '../shared/confirm-email-dialog';
import { type ReviewRow, ReviewSectionComponent } from '../shared/review-section';
import { StepShellComponent } from '../shared/step-shell';
import { ONB_WIDTH, onbButton } from '../shared/ui-classes';
import { GENDER_OPTIONS } from './personal-step';

export const REVIEW_SUBTITLE = "Check everything is right. Use Edit to change a section — you'll come straight back here.";

interface ReviewSection {
  key: ApplicationStepKey;
  title: string;
  rows: ReviewRow[];
}

const countryName = (iso: unknown): string =>
  typeof iso === 'string' ? (WORLD_COUNTRIES.find((c) => c.iso === iso)?.name ?? iso) : '';
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** Builds the review rows from a draft (spec §6.5.10). */
export function reviewSections(draft: ApplicationDraftDto): ReviewSection[] {
  const s = draft.sections;
  const route = draft.licence_route;
  const docs = draft.documents;
  const fileName = (slot: ApplicationDocumentSlot) => documentInSlot(docs, slot)?.original_name ?? '';
  const p = s.personal ?? {};
  const pr = s.professional ?? {};
  const l = s.licence ?? {};
  const ind = s.indemnity ?? {};
  const c = s.consent ?? {};
  const years = typeof pr.years_experience === 'number' ? pr.years_experience : null;
  const place = [text(p.city), countryName(p.country_of_residence)].filter(Boolean).join(', ');
  const licenceRows: ReviewRow[] =
    route === 'ng'
      ? [
          { label: 'MDCN registration number', value: text(l.mdcn_number) },
          { label: 'Year of full registration', value: text(l.full_registration_year) },
          { label: 'Annual practising licence expiry', value: formatDateLong(l.licence_expires_on) },
          { label: 'MDCN full registration certificate', value: fileName(licenceSlot(route)) },
        ]
      : [
          {
            label: 'Regulator',
            value: l.regulator_name
              ? `${text(l.regulator_name)}${l.regulator_country ? ` (${countryName(l.regulator_country)})` : ''}`
              : '',
          },
          { label: 'Licence number', value: text(l.registration_number) },
          { label: 'Good Standing issued', value: formatDateLong(l.good_standing_issued_on) },
          { label: 'Certificate of Good Standing', value: fileName(licenceSlot(route)) },
        ];
  const entries = s.qualifications?.entries ?? [];
  const accepted = (v: unknown) => (v === true ? 'Accepted' : '');
  return [
    {
      key: 'personal',
      title: 'Personal Details',
      rows: [
        { label: 'Full name', value: [text(p.first_name), text(p.last_name)].filter(Boolean).join(' ') },
        { label: 'Email address', value: text(p.email) },
        { label: 'Phone number', value: formatPhone(text(p.phone)) },
        { label: 'Date of birth', value: formatDateLong(p.date_of_birth) },
        { label: 'Gender', value: GENDER_OPTIONS.find((g) => g.value === p.gender)?.label ?? '' },
        { label: 'Country / City', value: place },
      ],
    },
    {
      key: 'professional',
      title: 'Professional Details',
      rows: [
        { label: 'Specialty', value: text(pr.specialty) },
        { label: 'Experience', value: years === null ? '' : `${years} ${years === 1 ? 'year' : 'years'}` },
        { label: 'Workplace', value: text(pr.workplace) },
        { label: 'Languages', value: Array.isArray(pr.languages) ? pr.languages.join(', ') : '' },
        { label: 'Short bio', value: text(pr.bio) },
      ],
    },
    { key: 'licence', title: stepTitle('licence', route), rows: licenceRows },
    {
      key: 'qualifications',
      title: 'Qualifications',
      rows: entries.map((e, i) => ({
        label: i === 0 ? 'Primary Medical Degree' : `Additional Qualification ${i}`,
        value: [text(e.degree), text(e.institution), text(e.year_awarded)].filter(Boolean).join(' · '),
      })),
    },
    {
      key: 'documents',
      title: 'Documents',
      rows: DOCUMENT_STEP_SLOTS.map((slot) => ({
        label: slotCopy(slot, route, text(l.regulator_name)).label,
        value: fileName(slot),
      })),
    },
    {
      key: 'indemnity',
      title: 'Indemnity',
      rows: [
        { label: 'Provider', value: text(ind.provider) },
        { label: 'Policy number', value: text(ind.policy_number) },
        { label: 'Cover expiry', value: formatDateLong(ind.cover_expires_on) },
        { label: 'Indemnity certificate', value: fileName('indemnity_certificate') },
      ],
    },
    {
      key: 'consent',
      title: 'Consent',
      rows: [
        { label: 'Terms of Service and Privacy Policy', value: accepted(c.accept_terms) },
        { label: 'Verification of my licence, qualifications and indemnity', value: accepted(c.authorise_verification) },
        { label: 'Information and documents accurate and complete', value: accepted(c.confirm_accurate) },
        { label: 'Signature', value: text(c.signature_name) },
      ],
    },
  ];
}

/** "A", "A and B", "A, B and C". */
function listText(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

type Problem =
  | { kind: 'incomplete'; steps: { key: ApplicationStepKey; title: string }[] }
  | { kind: 'duplicate'; message: string }
  | { kind: 'registered'; message: string }
  | { kind: 'error'; message: string };

/** /apply/review (Figma App 19): every section with Edit, then Cancel / Submit below the card. */
@Component({
  selector: 'onb-review',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    CancelDialogComponent,
    ConfirmEmailDialogComponent,
    IconComponent,
    ReviewSectionComponent,
    RouterLink,
    StepShellComponent,
  ],
  template: `
    <onb-step-shell heading="Review your application" [subtitle]="subtitle" (back)="back()">
      @if (problem(); as p) {
        <div class="mt-6">
          @switch (p.kind) {
            @case ('incomplete') {
              <sd-alert tone="error">
                Complete every step before you submit:
                <ul class="mt-1 list-disc pl-5">
                  @for (s of p.steps; track s.key) {
                    <li><a [routerLink]="url(s.key)" class="font-medium underline underline-offset-2">{{ s.title }}</a></li>
                  }
                </ul>
              </sd-alert>
            }
            @case ('duplicate') {
              <sd-alert tone="warning">
                {{ p.message }}
                <a routerLink="/" [queryParams]="{ dialog: 'track' }" class="ml-1 font-medium underline underline-offset-2">Check status</a>
              </sd-alert>
            }
            @case ('registered') {
              <sd-alert tone="warning">
                {{ p.message }}
                <a [href]="loginUrl()" class="ml-1 font-medium underline underline-offset-2">Sign in to the doctor portal</a>
              </sd-alert>
            }
            @default {
              <sd-alert tone="error">{{ p.message }}</sd-alert>
            }
          }
        </div>
      }
      <div class="mt-8 min-[900px]:mt-10 lg:-mr-4 lg:max-h-[470px] lg:overflow-y-auto lg:pr-4 onb-scroll" tabindex="0" role="region" aria-label="Your answers">
        <div class="flex flex-col gap-6 pb-1">
          @for (section of sections(); track section.key) {
            <onb-review-section
              [sectionId]="'review-' + section.key"
              [title]="section.title"
              [rows]="section.rows"
              [editLabel]="'Edit ' + section.title"
              (edit)="edit(section.key)"
            />
          }
        </div>
      </div>

      <div afterCard class="mt-6 flex w-full max-w-[864px] flex-col gap-3 min-[900px]:mt-14 min-[900px]:flex-row-reverse min-[900px]:justify-center min-[900px]:gap-6">
        <button
          type="button"
          [class]="submitClass()"
          [attr.aria-disabled]="!ready() || null"
          [attr.aria-busy]="busy() || null"
          (click)="submit()"
        >
          @if (busy()) {
            <sd-icon name="loader-circle" [size]="20" class="animate-spin" />
          }
          Submit application
          <sd-icon name="arrow-right" [size]="24" [strokeWidth]="1.5" />
        </button>
        <button type="button" [class]="cancelClass" [disabled]="busy()" (click)="cancelOpen.set(true)">Cancel application</button>
      </div>
    </onb-step-shell>

    <onb-confirm-email-dialog [open]="confirmOpen()" (verified)="onVerified()" (closed)="confirmOpen.set(false)" />
    <onb-cancel-dialog
      [open]="cancelOpen()"
      mode="draft"
      [busy]="cancelBusy()"
      [error]="cancelError()"
      (confirm)="confirmCancel()"
      (closed)="cancelOpen.set(false)"
    />
  `,
})
export class OnbReview implements CanLeave {
  private readonly store = inject(ApplicationDraftStore);
  private readonly router = inject(Router);
  private readonly notices = inject(Notices);
  private readonly announcer = inject(Announcer);
  private readonly config = inject(OnboardingConfigStore);
  private readonly dialogs = inject(DialogService);
  /** The page had a draft session; losing it means nothing can be saved any more (as StepBase). */
  private readonly inSession = this.store.hasToken();

  protected readonly subtitle = REVIEW_SUBTITLE;
  protected readonly sections = computed(() => {
    const d = this.store.draft();
    return d ? reviewSections(d) : [];
  });
  protected readonly ready = computed(() => !!this.store.draft()?.ready_to_submit);
  protected readonly busy = signal(false);
  protected readonly problem = signal<Problem | null>(null);
  protected readonly confirmOpen = signal(false);
  protected readonly cancelOpen = signal(false);
  protected readonly cancelBusy = signal(false);
  protected readonly cancelError = signal<string | null>(null);
  protected readonly submitClass = computed(() => `${onbButton('primary', !this.ready())} ${ONB_WIDTH[323]}`);
  protected readonly cancelClass = `${onbButton('outlineAlert')} ${ONB_WIDTH[323]} disabled:opacity-60`;
  protected readonly loginUrl = () => this.config.loginUrl();

  constructor() {
    this.store.returnToReview.set(false);
    void this.config.load();
    // Unsaved values kept in memory from a step (Back from an Edit): warn before the tab closes, as the steps do.
    warnBeforeUnload(() => this.store.pending.size > 0);
  }

  /**
   * Leaving the review page (StepBase.canLeave's rules): within the wizard the
   * unsaved values kept from a step stay in memory; leaving the wizard with
   * any asks first, and dropping them clears them all.
   */
  canLeave(): boolean | Promise<boolean> {
    if (this.store.pending.size === 0) return true;
    // The session ended under us (the interceptor dropped the token): nothing can be saved, so no prompt.
    if (this.inSession && !this.store.hasToken()) return true;
    const nav = this.router.currentNavigation();
    const target = (nav?.finalUrl ?? nav?.extractedUrl)?.toString() ?? '';
    if (target.startsWith('/apply')) return true;
    return this.dialogs
      .confirmLeave({
        title: 'Leave your application?',
        message: "Some of your latest changes haven't been saved. If you leave now, they'll be lost.",
      })
      .then((leave) => {
        if (leave) this.store.pending.clear();
        return leave;
      });
  }

  /** The titles of the steps whose unsaved values are kept in memory, in wizard order. */
  private unsavedTitles(): string[] {
    const route = this.store.draft()?.licence_route ?? 'ng';
    return STEPS.filter((s) => this.store.pending.has(s.key)).map((s) => stepTitle(s.key, route));
  }

  /** Submitting sends what the server has: unsaved step values would silently be left out, so ask first. */
  private async confirmDropUnsaved(): Promise<boolean> {
    const titles = this.unsavedTitles();
    const { confirmed } = await this.dialogs.confirm({
      tone: 'warning',
      title: 'Submit without your latest changes?',
      message: `Your changes to ${listText(titles)} haven't been saved, so they won't be part of your application. To keep them, use Edit and then Save and return.`,
      confirmLabel: 'Submit anyway',
      cancelLabel: 'Go back',
    });
    if (confirmed) this.store.pending.clear();
    return confirmed;
  }

  protected url(step: ApplicationStepKey): string {
    return stepUrl(step);
  }

  protected back(): void {
    void this.router.navigateByUrl(stepUrl('consent'));
  }

  protected edit(step: ApplicationStepKey): void {
    this.store.returnToReview.set(true);
    void this.router.navigateByUrl(`${stepUrl(step)}?return=review`);
  }

  private incompleteSteps(): { key: ApplicationStepKey; title: string }[] {
    const d = this.store.draft();
    if (!d) return [];
    return STEPS.filter((s) => d.steps[s.key] !== 'complete').map((s) => ({
      key: s.key,
      title: stepTitle(s.key, d.licence_route),
    }));
  }

  protected submit(): void {
    if (this.busy()) return;
    this.problem.set(null);
    const missing = this.incompleteSteps();
    if (!this.ready() || missing.length) {
      this.problem.set({ kind: 'incomplete', steps: missing });
      this.announcer.announce('Complete every step before you submit.');
      return;
    }
    if (this.store.pending.size > 0) {
      void this.confirmDropUnsaved().then((go) => {
        if (go) this.submit();
      });
      return;
    }
    if (!this.store.draft()?.email_verified) {
      this.confirmOpen.set(true);
      return;
    }
    void this.doSubmit();
  }

  protected onVerified(): void {
    this.confirmOpen.set(false);
    void this.doSubmit();
  }

  private async doSubmit(): Promise<void> {
    this.busy.set(true);
    try {
      await this.store.submit();
      await this.router.navigateByUrl('/apply/submitted');
    } catch (err) {
      const code = apiErrorCode(err);
      if (code === 'email_unverified') {
        this.confirmOpen.set(true);
      } else if (code === 'incomplete') {
        await this.store.refresh().catch(() => undefined);
        this.problem.set({ kind: 'incomplete', steps: this.incompleteSteps() });
      } else if (code === 'duplicate_open_application') {
        this.problem.set({ kind: 'duplicate', message: bannerMessage(err) });
      } else if (code === 'already_registered') {
        this.problem.set({ kind: 'registered', message: bannerMessage(err) });
      } else if (code && DRAFT_ENDED.has(code)) {
        if (code !== 'draft_submitted') {
          this.notices.set('resume', NOTICE.sessionEnded);
          await this.router.navigateByUrl('/?dialog=resume');
        }
      } else {
        this.problem.set({ kind: 'error', message: bannerMessage(err, "We couldn't submit your application. Please try again.") });
      }
      if (this.problem()) this.announcer.announce(this.problem()?.kind === 'incomplete' ? 'Complete every step before you submit.' : 'Your application was not submitted.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async confirmCancel(): Promise<void> {
    this.cancelBusy.set(true);
    this.cancelError.set(null);
    try {
      await this.store.discard();
      this.cancelOpen.set(false);
      this.notices.set('landing', NOTICE.cancelled);
      await this.router.navigateByUrl('/');
    } catch (err) {
      // The session already ended (as StepBase.confirmCancel): nothing is left to cancel here.
      const code = apiErrorCode(err) ?? '';
      if (DRAFT_ENDED.has(code)) {
        this.store.clear();
        this.cancelOpen.set(false);
        // Submitted elsewhere: not cancelled; the interceptor is opening the Track modal.
        if (code === 'draft_submitted') return;
        this.notices.set('landing', NOTICE.cancelled);
        await this.router.navigateByUrl('/');
        return;
      }
      this.cancelError.set(bannerMessage(err, "We couldn't cancel your application. Please try again."));
    } finally {
      this.cancelBusy.set(false);
    }
  }
}
