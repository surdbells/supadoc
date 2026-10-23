import { computed, Directive, inject, input, output, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type { CanLeave } from '@supadoc/auth';
import type { ApplicationSectionKey, ApplicationStepKey } from '@supadoc/models';
import { DialogService, warnBeforeUnload } from '@supadoc/ui';
import { Announcer } from '../core/announcer';
import { ApplicationDraftStore, type SectionDraft } from '../core/application-draft.store';
import { apiErrorCode, bannerMessage, DRAFT_ENDED, errorStatus, fieldErrors } from '../core/errors';
import { clinicToday } from '../core/format';
import { InfoResponseStore } from '../core/info-response.store';
import { NOTICE, Notices } from '../core/notices';
import { OnboardingConfigStore } from '../core/onboarding-config.store';
import type { StepSource } from '../core/step-source';
import { nextStepKey, previousStepKey, stepOf, stepTitle, stepUrl } from '../core/wizard-steps';
import { focusFirstInvalid, FormState, SlotUploads, UPLOAD_REQUIRED } from '../shared/form-state';

export type StepMode = 'wizard' | 'info';

/** The standard form subtitle (spec §6.10). */
export const FORM_SUBTITLE = 'Fill in the following information correctly. (Fields marked * are required)';

/**
 * Shared behaviour of the seven step pages (spec §6.5, §6.6, §6.7):
 * Continue / Save & continue later / Cancel application / Back in the wizard,
 * a single Save in info mode (the "Send requested items" page), the D29
 * "show what is missing" click, 422 mapping, ended sessions, and keeping
 * unsaved values in memory when moving between steps.
 */
@Directive()
export abstract class StepBase implements CanLeave {
  protected readonly store = inject(ApplicationDraftStore);
  protected readonly info = inject(InfoResponseStore, { optional: true });
  protected readonly router = inject(Router);
  protected readonly announcer = inject(Announcer);
  protected readonly notices = inject(Notices);
  protected readonly configStore = inject(OnboardingConfigStore);
  private readonly dialogs = inject(DialogService);

  /** `info`: rendered inside the respond page, saving through the track endpoints. */
  readonly mode = input<StepMode>('wizard');
  /** Info mode: the section was saved. */
  readonly saved = output<void>();

  abstract readonly key: ApplicationStepKey;
  /** The form's error policy (client rules + server answers). */
  protected abstract readonly form: FormState;
  /** The values to save, in the API's shape. */
  protected abstract payload(): Record<string, unknown>;
  /** Field keys in screen order (first invalid gets focus). */
  protected abstract fieldOrder(): string[];
  /** The section rules (§2.11) on the current values. */
  protected abstract validate(partial: boolean): Record<string, string>;

  /** Info mode: inside the respond page (which provides InfoResponseStore), or asked for. */
  protected readonly isInfo = computed(() => this.mode() === 'info' || this.info !== null);
  protected readonly wizard = computed(() => !this.isInfo());
  /** Where the step reads and uploads. Decided by DI, so it is right while the component is built. */
  protected readonly source = (): StepSource => this.info ?? this.store;
  protected readonly uploads = new SlotUploads(() => this.source());
  protected readonly today = clinicToday();
  protected readonly busy = signal(false);
  protected readonly banner = signal<string | null>(null);
  protected readonly savedOpen = signal(false);
  protected readonly savedTo = signal('');
  protected readonly savedCooldown = signal(false);
  protected readonly cancelOpen = signal(false);
  protected readonly cancelBusy = signal(false);
  protected readonly cancelError = signal<string | null>(null);
  protected readonly returnMode = computed(() => this.wizard() && this.store.returnToReview());
  protected readonly primaryLabel = computed(() => (this.returnMode() ? 'Save and return' : 'Continue'));
  /** Slot keys required on this step that have no document yet (Continue shows their error). */
  protected missingUploads(): string[] {
    return [];
  }
  /** Element id for a field key. */
  protected idOf(key: string): string {
    return `onb-${key.replace(/\./g, '-')}`;
  }

  private baseline = '';
  /** The form started from unsaved values kept in `pending`: it differs from the server until saved. */
  private restored = false;
  private leaving = false;
  /** The step has a draft session (a token); losing it means nothing here can be saved any more. */
  private inSession = this.store.hasToken();

  protected readonly stepNumber = computed(() => stepOf(this.key).n);
  protected readonly heading = computed(() => stepTitle(this.key, this.source().route()));

  constructor() {
    // Unsaved values on this step, or kept in memory from another step (§1.2, §6.6 anyDirty).
    warnBeforeUnload(() => this.wizard() && this.unsaved());
    // `?return=review` (Edit on the review page): the primary button and Back return there.
    if (!this.info) {
      const ret = inject(ActivatedRoute, { optional: true })?.snapshot.queryParamMap.get('return');
      this.store.returnToReview.set(ret === 'review');
    }
  }

  /** Remember the current values as the starting point (call after building the form). */
  protected markBaseline(): void {
    this.baseline = JSON.stringify(this.payload());
  }

  /** The values were saved: they are the server's now (call instead of markBaseline after a save). */
  protected markSaved(): void {
    this.restored = false;
    if (this.store.hasToken()) this.inSession = true;
    this.markBaseline();
  }

  /** This step holds values the server does not have (edited here, or restored from memory). */
  dirty(): boolean {
    return this.restored || JSON.stringify(this.payload()) !== this.baseline;
  }

  /** Unsaved values on this step or on any other step (kept in `pending`). */
  private unsaved(): boolean {
    return this.dirty() || this.store.pending.size > 0;
  }

  /** The values the form starts with: unsaved ones from memory, else the server's. */
  protected initialValues<T>(saved: T | null | undefined): T | null {
    const pending = this.info ? undefined : (this.store.pending.get(this.key) as T | undefined);
    if (pending !== undefined) this.restored = true;
    return pending ?? saved ?? null;
  }

  /** The D29 click: everything missing shown, the first focused, the count announced. */
  protected revealProblems(): boolean {
    const missing = this.missingUploads();
    for (const key of missing) this.uploads.setError(key, UPLOAD_REQUIRED);
    const count = this.form.reveal() + missing.length;
    if (count === 0) return false;
    const errors: Record<string, string> = { ...this.form.all() };
    for (const key of missing) errors[key] = UPLOAD_REQUIRED;
    focusFirstInvalid([...this.fieldOrder(), ...missing], errors, (k) => this.idOf(k));
    this.announcer.announce(`Fix ${count} ${count === 1 ? 'field' : 'fields'} to continue.`);
    return true;
  }

  /** Saves this step (wizard). The personal and documents steps override it. */
  protected async persist(partial: boolean): Promise<void> {
    await this.store.saveSection(this.key as ApplicationSectionKey, this.payload() as SectionDraft<ApplicationSectionKey>, partial);
  }

  async onContinue(): Promise<void> {
    if (this.busy()) return;
    this.banner.set(null);
    if (this.revealProblems()) return;
    this.busy.set(true);
    try {
      await this.persist(false);
      this.markSaved();
      await this.navigateForward();
    } catch (err) {
      this.handleError(err);
    } finally {
      this.busy.set(false);
    }
  }

  protected async navigateForward(): Promise<void> {
    this.leaving = true;
    const target = this.returnMode() ? 'review' : nextStepKey(this.key);
    await this.router.navigateByUrl(stepUrl(target));
  }

  goBack(): void {
    if (!this.wizard()) return;
    if (this.returnMode()) {
      void this.router.navigateByUrl('/apply/review');
      return;
    }
    const prev = previousStepKey(this.key);
    void this.router.navigateByUrl(prev ? stepUrl(prev) : '/apply');
  }

  /** What Save & continue later saves (null: nothing, just send the resume email). */
  protected laterPayload(): Record<string, unknown> | null {
    return this.key === 'documents' ? null : this.payload();
  }

  /** Format problems that would make a partial save fail (blank fields are fine). */
  protected partialProblems(): Record<string, string> {
    return this.validate(true);
  }

  async onSaveLater(): Promise<void> {
    if (this.busy()) return;
    this.banner.set(null);
    const problems = this.partialProblems();
    if (Object.keys(problems).length) {
      this.form.setServer(problems);
      focusFirstInvalid(this.fieldOrder(), problems, (k) => this.idOf(k));
      const n = Object.keys(problems).length;
      this.announcer.announce(`Fix ${n} ${n === 1 ? 'field' : 'fields'} to save.`);
      return;
    }
    this.busy.set(true);
    try {
      const values = this.laterPayload();
      const { sent_to } = await this.store.saveForLater(this.key, values);
      if (values !== null) this.markSaved();
      this.savedTo.set(sent_to);
      this.savedCooldown.set(false);
      this.savedOpen.set(true);
    } catch (err) {
      if (apiErrorCode(err) === 'resend_cooldown') {
        // The step was saved; only the email was held back (one went out under a minute ago).
        if (this.laterPayload() !== null) this.markSaved();
        this.savedCooldown.set(true);
        this.savedOpen.set(true);
      } else {
        this.handleError(err);
      }
    } finally {
      this.busy.set(false);
    }
  }

  onCancel(): void {
    this.cancelError.set(null);
    this.cancelOpen.set(true);
  }

  async confirmCancel(): Promise<void> {
    this.cancelBusy.set(true);
    this.cancelError.set(null);
    try {
      await this.store.discard();
      this.cancelOpen.set(false);
      this.leaving = true;
      this.notices.set('landing', NOTICE.cancelled);
      await this.router.navigateByUrl('/');
    } catch (err) {
      const code = apiErrorCode(err) ?? '';
      if (DRAFT_ENDED.has(code)) {
        this.store.clear();
        this.cancelOpen.set(false);
        this.leaving = true;
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

  savedHome(): void {
    this.savedOpen.set(false);
    this.leaving = true;
    void this.router.navigateByUrl('/');
  }

  /** Info mode: full validation, then PUT track/info-response/sections/{key}. */
  async onInfoSave(): Promise<void> {
    if (this.busy() || !this.info) return;
    this.banner.set(null);
    if (this.revealProblems()) return;
    this.busy.set(true);
    try {
      await this.info.saveSection(this.key as ApplicationSectionKey, this.payload() as SectionDraft<ApplicationSectionKey>);
      this.markSaved();
      this.form.reset();
      this.announcer.announce(`${this.heading()} updated.`);
      this.saved.emit();
    } catch (err) {
      this.handleError(err);
    } finally {
      this.busy.set(false);
    }
  }

  /** 422 → the fields; an ended session → Resume; anything else → the banner. */
  protected handleError(err: unknown): void {
    const code = apiErrorCode(err);
    if (code === 'draft_submitted') {
      // The interceptor is opening the Track modal: the draft is gone, so no "Leave?" prompt.
      this.leaving = true;
      return;
    }
    if (code && DRAFT_ENDED.has(code)) {
      this.leaving = true;
      this.notices.set('resume', code === 'draft_not_found' ? bannerMessage(err) : NOTICE.sessionEnded);
      void this.router.navigateByUrl('/?dialog=resume');
      return;
    }
    if (this.isInfo() && errorStatus(err) === 401) {
      this.leaving = true;
      this.notices.set('track', NOTICE.trackSessionEnded);
      void this.router.navigateByUrl('/?dialog=track');
      return;
    }
    const fields = fieldErrors(err);
    if (Object.keys(fields).length) {
      this.form.setServer(fields);
      this.form.submitted.set(true);
      focusFirstInvalid(this.fieldOrder(), fields, (k) => this.idOf(k));
      const n = Object.keys(fields).length;
      this.announcer.announce(`Fix ${n} ${n === 1 ? 'field' : 'fields'} to continue.`);
      return;
    }
    if (code === 'consent_outdated') void this.configStore.load();
    this.banner.set(bannerMessage(err));
  }

  /**
   * Leaving the page. Within the wizard (Back, a step link) unsaved values
   * stay in memory; leaving the wizard while this step or any other holds
   * unsaved values asks first, and dropping them clears them all.
   */
  canLeave(): boolean | Promise<boolean> {
    if (!this.wizard() || this.leaving) return true;
    // The session ended under us (the interceptor dropped the token and may be
    // redirecting before handleError runs): nothing can be saved, so no prompt.
    if (this.inSession && !this.store.hasToken()) return true;
    if (this.dirty()) this.store.pending.set(this.key, this.payload());
    else this.store.pending.delete(this.key);
    if (this.store.pending.size === 0) return true;
    const nav = this.router.currentNavigation();
    const target = (nav?.finalUrl ?? nav?.extractedUrl)?.toString() ?? '';
    if (target.startsWith('/apply')) return true;
    const onlyHere = this.store.pending.size === 1 && this.store.pending.has(this.key);
    return this.dialogs
      .confirmLeave({
        title: 'Leave your application?',
        message: onlyHere
          ? "Your latest changes on this step haven't been saved. Use Save & continue later to keep them."
          : "Some of your latest changes haven't been saved. If you leave now, they'll be lost.",
      })
      .then((leave) => {
        if (leave) this.store.pending.clear();
        return leave;
      });
  }
}
