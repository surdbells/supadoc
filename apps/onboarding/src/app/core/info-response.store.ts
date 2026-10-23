import { computed, inject, Injectable, signal } from '@angular/core';
import { DoctorApplicationsApi, openBlobDocument } from '@supadoc/data-access';
import type {
  ApplicantApplicationDto,
  ApplicationDocumentDto,
  ApplicationDocumentSlot,
  ApplicationSectionKey,
  ApplicationSections,
  ApplicationSectionValues,
  ApplicationStatusDto,
  LicenceRoute,
} from '@supadoc/models';
import { firstValueFrom, Observable, tap } from 'rxjs';
import { errorStatus } from './errors';
import { type StepSource, toUploadEvents, type UploadEvent } from './step-source';

const UPDATED_KEY = (requestId: string) => `videomed.onb.respond.${requestId}`;

function readUpdated(requestId: string): string[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(UPDATED_KEY(requestId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeUpdated(requestId: string, keys: string[]): void {
  try {
    globalThis.sessionStorage?.setItem(UPDATED_KEY(requestId), JSON.stringify(keys));
  } catch {
    // memory only
  }
}

/**
 * "Send requested items" (spec §6.5.14): the submitted application and its
 * open info request. Only the requested sections and slots can change; every
 * write goes through the track (access-token) endpoints. Which sections were
 * saved for this request comes from the server (`info_request.updated_sections`)
 * and is also remembered per tab (section keys only).
 */
@Injectable()
export class InfoResponseStore implements StepSource {
  readonly kind = 'info' as const;
  private readonly api = inject(DoctorApplicationsApi);

  readonly application = signal<ApplicantApplicationDto | null>(null);
  readonly request = computed(() => this.application()?.info_request ?? null);
  /** Section keys saved since the request was made. */
  readonly updatedSections = signal<ReadonlySet<string>>(new Set());

  readonly requestedSections = computed(
    () =>
      (this.request()?.items ?? []).filter((i) => i.kind === 'section').map((i) => i.key) as ApplicationSectionKey[],
  );
  readonly requestedSlots = computed(() => (this.request()?.items ?? []).filter((i) => i.kind === 'document'));

  async load(): Promise<ApplicantApplicationDto> {
    const res = await firstValueFrom(this.api.application());
    this.adopt(res.data);
    return res.data;
  }

  /**
   * The server says which requested sections were saved since the request
   * (`updated_sections`, so a new tab or device knows); this tab's own record
   * is merged in for an API that doesn't send it yet.
   */
  private adopt(app: ApplicantApplicationDto): void {
    this.application.set(app);
    const id = app.info_request?.id;
    this.updatedSections.set(new Set(id ? [...(app.info_request?.updated_sections ?? []), ...readUpdated(id)] : []));
  }

  route(): LicenceRoute {
    return this.application()?.licence_route ?? 'ng';
  }

  sections(): ApplicationSections | null {
    return this.application()?.sections ?? null;
  }

  documents(): readonly ApplicationDocumentDto[] {
    return this.application()?.documents ?? [];
  }

  slotEditable(slot: ApplicationDocumentSlot): boolean {
    return this.requestedSlots().some((i) => i.key === slot);
  }

  /** Only files sent in this response can be taken back (the server reactivates the one replaced). */
  documentRemovable(doc: ApplicationDocumentDto): boolean {
    return doc.uploaded_during === 'info_response' && this.uploadedForRequest(doc);
  }

  /** Uploaded since the request was made. */
  uploadedForRequest(doc: ApplicationDocumentDto): boolean {
    const req = this.request();
    if (!req) return false;
    return doc.uploaded_during === 'info_response' && Date.parse(doc.uploaded_at) >= Date.parse(req.requested_at);
  }

  sectionUpdated(key: string): boolean {
    return this.updatedSections().has(key);
  }

  async saveSection<K extends ApplicationSectionKey>(
    key: K,
    values: Partial<ApplicationSectionValues[K]>,
  ): Promise<ApplicantApplicationDto> {
    const res = await firstValueFrom(this.api.saveInfoSection(key, { values })).catch((err: unknown) => {
      this.refreshIfMovedOn(err);
      throw err;
    });
    this.application.set(res.data);
    const id = res.data.info_request?.id;
    const next = new Set([...this.updatedSections(), ...(res.data.info_request?.updated_sections ?? []), key]);
    this.updatedSections.set(next);
    if (id) writeUpdated(id, [...next]);
    return res.data;
  }

  upload(slot: ApplicationDocumentSlot, file: File): Observable<UploadEvent> {
    return toUploadEvents(this.api.uploadInfoDocument(slot, file)).pipe(
      tap({
        next: (event) => {
          if (!('done' in event)) return;
          const doc = event.done;
          this.application.update((app) => {
            if (!app) return app;
            const keep = app.documents.filter(
              (d) => !(d.slot === doc.slot && (doc.slot !== 'additional' || d.label === doc.label)),
            );
            return { ...app, documents: [...keep, doc] };
          });
        },
        error: (err: unknown) => this.refreshIfMovedOn(err),
      }),
    );
  }

  async removeDocument(doc: ApplicationDocumentDto): Promise<void> {
    await firstValueFrom(this.api.removeInfoDocument(doc.id)).catch((err: unknown) => {
      this.refreshIfMovedOn(err);
      throw err;
    });
    // The server put back the document this one replaced: reload to show it.
    await this.load();
  }

  /**
   * A 409 (`not_allowed`): the application stopped waiting on the applicant
   * while the page was open (staff resumed the review, or it was decided).
   * Re-read it so the page stops offering edits the server will refuse; the
   * caller still shows the server's message.
   */
  private refreshIfMovedOn(err: unknown): void {
    if (errorStatus(err) !== 409) return;
    this.load().catch(() => undefined);
  }

  viewDocument(doc: ApplicationDocumentDto): void {
    openBlobDocument(this.api.trackDocumentFile(doc.id));
  }

  async submit(note: string | null): Promise<ApplicationStatusDto> {
    const res = await firstValueFrom(this.api.submitInfoResponse({ note }));
    const id = this.request()?.id;
    if (id) {
      try {
        globalThis.sessionStorage?.removeItem(UPDATED_KEY(id));
      } catch {
        // nothing stored
      }
    }
    return res.data;
  }
}
