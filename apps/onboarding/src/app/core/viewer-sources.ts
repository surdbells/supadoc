import type { Injector } from '@angular/core';
import type { ApplicationDocumentDto } from '@supadoc/models';
import { blobSource, DocumentViewerService, type ViewerRef, type ViewerSource } from '@supadoc/viewer';
import type { Observable } from 'rxjs';
import { formatBytes } from './format';

/*
 * The applicant's own documents in the shared viewer (spec §6.4, O-1/O-2).
 * The stores that open them are in the initial bundle (the wizard guards use
 * the draft store), so they import this file dynamically, on the click: a
 * static import would put `@supadoc/viewer` in the initial bundle too.
 */

/** The header's file kind, from the stored type (PDF, PNG or JPG). */
const EXTENSION: Readonly<Record<string, string>> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

/** One of the applicant's own application documents: view, print and download (`owner`). */
export function applicantDocumentSource(fetch: () => Observable<Blob>, doc: ApplicationDocumentDto): ViewerSource {
  return blobSource({
    key: 'appdoc:' + doc.id,
    title: doc.original_name,
    typeLabel: doc.slot_label,
    extension: EXTENSION[doc.mime] ?? null,
    sizeLabel: formatBytes(doc.size_bytes),
    policy: 'owner',
    filename: doc.original_name,
    fetch,
  });
}

/** Opens `doc` in the viewer (the opener is the focused control, where focus returns on close). */
export function openApplicantDocument(injector: Injector, fetch: () => Observable<Blob>, doc: ApplicationDocumentDto): ViewerRef {
  return injector.get(DocumentViewerService).open(applicantDocumentSource(fetch, doc));
}
