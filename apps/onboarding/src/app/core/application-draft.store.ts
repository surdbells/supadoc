import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { DoctorApplicationsApi, openBlobDocument } from '@supadoc/data-access';
import type {
  ApplicationDocumentDto,
  ApplicationDocumentSlot,
  ApplicationDraftDto,
  ApplicationPersonal,
  ApplicationSectionKey,
  ApplicationSections,
  ApplicationSectionValues,
  ApplicationStepKey,
  CodeSentDto,
  LicenceRoute,
  ResumeEmailSentDto,
  SubmittedApplicationDto,
} from '@supadoc/models';
import { firstValueFrom, Observable, tap } from 'rxjs';
import { ApplicantSession } from './applicant-session';
import { type StepSource, toUploadEvents, type UploadEvent } from './step-source';

/** Values as the step forms hold them (blank fields allowed when partial). */
export type SectionDraft<K extends ApplicationSectionKey> = Partial<ApplicationSectionValues[K]>;

/**
 * The applicant's draft (spec §6.6). Before step 1 is saved only the licence
 * route exists (sessionStorage); from then on the server holds the draft and
 * this store mirrors it. Unsaved form values live in `pending` (memory) so Back
 * and forward keep them; nothing personal is written to browser storage.
 */
@Injectable({ providedIn: 'root' })
export class ApplicationDraftStore implements StepSource {
  readonly kind = 'wizard' as const;
  private readonly api = inject(DoctorApplicationsApi);
  private readonly session = inject(ApplicantSession);

  /** The server truth once a draft exists. */
  readonly draft = signal<ApplicationDraftDto | null>(null);
  private readonly localRoute = signal<LicenceRoute | null>(this.session.readRoute());
  readonly route = computed<LicenceRoute>(() => this.draft()?.licence_route ?? this.localRoute() ?? 'ng');
  /** Whether a licence route has been chosen at all. */
  readonly hasRoute = computed(() => !!this.draft() || this.localRoute() !== null);
  readonly hasToken = computed(() => !!this.session.draftToken());
  /** Unsaved form values per step (memory only). */
  readonly pending = new Map<ApplicationStepKey, unknown>();
  /** Edit came from the review page: the primary button returns there. */
  readonly returnToReview = signal(false);
  /** The submitted application (memory only; a reload loses it). */
  readonly submission = signal<SubmittedApplicationDto | null>(null);
  private hadToken = false;

  constructor() {
    // The token was dropped (expired, discarded, submitted elsewhere): forget the
    // draft and the unsaved values that belonged to it (they would otherwise be
    // restored into a new application and keep the "unsaved changes" warnings on).
    effect(() => {
      if (!this.session.draftToken()) {
        untracked(() => {
          this.draft.set(null);
          if (this.hadToken) this.pending.clear();
        });
      }
      this.hadToken = !!this.session.draftToken();
    });
  }

  sections(): ApplicationSections | null {
    return this.draft()?.sections ?? null;
  }

  documents(): readonly ApplicationDocumentDto[] {
    return this.draft()?.documents ?? [];
  }

  slotEditable(): boolean {
    return true;
  }

  documentRemovable(): boolean {
    return true;
  }

  /** Loads the draft for the stored token (null without one, or when the token is no longer valid). */
  async ensureLoaded(): Promise<ApplicationDraftDto | null> {
    if (!this.session.draftToken()) return null;
    const current = this.draft();
    if (current) return current;
    try {
      return await this.refresh();
    } catch (err) {
      // The interceptor drops the token on 401 / draft_not_found / draft_submitted.
      if (!this.session.draftToken()) return null;
      throw err;
    }
  }

  /** GET drafts/current. */
  async refresh(): Promise<ApplicationDraftDto> {
    const res = await firstValueFrom(this.api.getDraft());
    this.draft.set(res.data);
    return res.data;
  }

  /** Step 0. With a draft, PATCH (clears the licence details and certificate). */
  async chooseRoute(route: LicenceRoute): Promise<void> {
    if (this.draft() && this.session.draftToken()) {
      if (this.draft()?.licence_route === route) return;
      const res = await firstValueFrom(this.api.changeRoute(route));
      this.draft.set(res.data);
      this.pending.delete('licence');
      return;
    }
    this.localRoute.set(route);
    this.session.writeRoute(route);
  }

  /**
   * Step 1: POST /drafts when there is no draft yet (the server emails the
   * resume link and code), otherwise PUT the section. `sentTo` is the masked
   * address the resume email went to (creation only).
   */
  async savePersonal(
    values: SectionDraft<'personal'>,
    partial: boolean,
  ): Promise<{ draft: ApplicationDraftDto; sentTo: string | null }> {
    if (!this.session.draftToken()) {
      const res = await firstValueFrom(
        this.api.createDraft({ licence_route: this.route(), personal: values as Partial<ApplicationPersonal>, partial }),
      );
      this.session.setDraftToken(res.data.draft_token);
      this.session.writeRoute(null);
      this.localRoute.set(null);
      this.draft.set(res.data.draft);
      this.pending.delete('personal');
      return { draft: res.data.draft, sentTo: res.data.resume_email_sent_to };
    }
    return { draft: await this.saveSection('personal', values, partial), sentTo: null };
  }

  async saveSection<K extends ApplicationSectionKey>(
    key: K,
    values: SectionDraft<K>,
    partial: boolean,
  ): Promise<ApplicationDraftDto> {
    const res = await firstValueFrom(this.api.saveSection(key, { values, partial }));
    this.draft.set(res.data);
    this.pending.delete(key);
    return res.data;
  }

  upload(slot: ApplicationDocumentSlot, file: File): Observable<UploadEvent> {
    return toUploadEvents(this.api.uploadDocument(slot, file)).pipe(
      tap((event) => {
        if ('done' in event) {
          const doc = event.done;
          this.draft.update((d) =>
            d ? { ...d, documents: [...d.documents.filter((x) => x.slot !== doc.slot), doc] } : d,
          );
          // Step completeness depends on the files: refresh it (errors are not the upload's).
          this.refresh().catch(() => undefined);
        }
      }),
    );
  }

  async removeDocument(doc: ApplicationDocumentDto): Promise<void> {
    await firstValueFrom(this.api.removeDocument(doc.id));
    this.draft.update((d) => (d ? { ...d, documents: d.documents.filter((x) => x.id !== doc.id) } : d));
    this.refresh().catch(() => undefined);
  }

  viewDocument(doc: ApplicationDocumentDto): void {
    openBlobDocument(this.api.documentFile(doc.id));
  }

  /** POST drafts/current/resume-email (429 resend_cooldown within 60 s). */
  async sendResumeEmail(): Promise<ResumeEmailSentDto> {
    const res = await firstValueFrom(this.api.sendResumeEmail());
    return res.data;
  }

  /**
   * "Save & continue later". Without a draft (step 1): POST /drafts only, whose
   * creation already emailed the link and code. Otherwise save the step with
   * `partial` (no fields on the documents step), then send the resume email.
   */
  async saveForLater(step: ApplicationStepKey, values: unknown): Promise<{ sent_to: string }> {
    if (!this.session.draftToken()) {
      const created = await this.savePersonal(values as SectionDraft<'personal'>, true);
      return { sent_to: created.sentTo ?? '' };
    }
    if (step !== 'documents' && values) {
      await this.saveSection(step, values as SectionDraft<typeof step>, true);
    }
    const sent = await this.sendResumeEmail();
    return { sent_to: sent.sent_to };
  }

  async requestEmailCode(): Promise<CodeSentDto> {
    const res = await firstValueFrom(this.api.sendEmailCode());
    return res.data;
  }

  async verifyEmail(code: string): Promise<ApplicationDraftDto> {
    const res = await firstValueFrom(this.api.verifyEmail({ code }));
    this.draft.set(res.data);
    return res.data;
  }

  /** POST submit: keeps the submission in memory and drops the draft token. */
  async submit(): Promise<SubmittedApplicationDto> {
    const res = await firstValueFrom(this.api.submit());
    this.submission.set(res.data);
    this.clear();
    return res.data;
  }

  /** "Cancel application": DELETE the draft (files first, server-side), then forget it. */
  async discard(): Promise<void> {
    if (this.session.draftToken()) await firstValueFrom(this.api.discardDraft());
    this.clear();
  }

  /** Forget the draft locally (token, route choice, unsaved values). Keeps `submission`. */
  clear(): void {
    this.session.setDraftToken(null);
    this.session.writeRoute(null);
    this.localRoute.set(null);
    this.draft.set(null);
    this.pending.clear();
    this.returnToReview.set(false);
  }

  /** A resumed session (link or code): adopt its token and draft. */
  adopt(token: string, draft: ApplicationDraftDto): void {
    this.pending.clear();
    this.returnToReview.set(false);
    this.session.setDraftToken(token);
    this.session.writeRoute(null);
    this.localRoute.set(null);
    this.draft.set(draft);
  }
}
