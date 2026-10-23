import { HttpEvent, HttpEventType } from '@angular/common/http';
import type {
  ApplicationDocumentDto,
  ApplicationDocumentSlot,
  ApplicationSections,
  LicenceRoute,
  SuccessResponse,
} from '@supadoc/models';
import { filter, map, Observable } from 'rxjs';

/** Progress of one upload: a percentage while sending, then the stored document. */
export type UploadEvent = { progress: number } | { done: ApplicationDocumentDto };

/**
 * What a step form reads and uploads through. The wizard uses the draft
 * (ApplicationDraftStore); the "Send requested items" page uses the submitted
 * application's info response (InfoResponseStore), where only the requested
 * slots can be changed.
 */
export interface StepSource {
  readonly kind: 'wizard' | 'info';
  route(): LicenceRoute;
  sections(): ApplicationSections | null;
  /** Active documents. */
  documents(): readonly ApplicationDocumentDto[];
  /** False: the slot is shown read-only (info mode, not in the open request). */
  slotEditable(slot: ApplicationDocumentSlot): boolean;
  /** False: no trash button (info mode: only files sent in this response can go). */
  documentRemovable(doc: ApplicationDocumentDto): boolean;
  upload(slot: ApplicationDocumentSlot, file: File): Observable<UploadEvent>;
  removeDocument(doc: ApplicationDocumentDto): Promise<void>;
  viewDocument(doc: ApplicationDocumentDto): void;
}

/** HttpClient upload events → UploadEvent (progress %, then the document). */
export function toUploadEvents(
  events$: Observable<HttpEvent<SuccessResponse<ApplicationDocumentDto>>>,
): Observable<UploadEvent> {
  return events$.pipe(
    map((event): UploadEvent | null => {
      if (event.type === HttpEventType.UploadProgress) {
        const total = event.total ?? 0;
        return { progress: total > 0 ? Math.min(99, Math.round((event.loaded / total) * 100)) : 0 };
      }
      if (event.type === HttpEventType.Response && event.body) return { done: event.body.data };
      return null;
    }),
    filter((e): e is UploadEvent => e !== null),
  );
}

/** The active document in a slot (the newest, for `additional`). */
export function documentInSlot(
  docs: readonly ApplicationDocumentDto[],
  slot: ApplicationDocumentSlot,
  label?: string | null,
): ApplicationDocumentDto | null {
  const matches = docs.filter(
    (d) => d.slot === slot && d.state === 'active' && (slot !== 'additional' || !label || d.label === label),
  );
  return matches.length ? matches[matches.length - 1] : null;
}
