import { type DoctorApi, formatInZone, type PrescriptionsApi } from '@supadoc/data-access';
import type {
  ClinicalDocumentKind,
  DoctorSharedDocumentDto,
  PrescriptionLinkDto,
  PrescriptionStatus,
  SpecialistCredentialDto,
} from '@supadoc/models';
import {
  blobSource,
  type DocumentViewerService,
  signedLinkSource,
  type ViewerErrorView,
  type ViewerSource,
  type ViewerWatermark,
  viewOnlySource,
} from '@supadoc/viewer';
import { map, type Observable, switchMap, take } from 'rxjs';
import { isViewableDoc, NOT_SHARED, sharedUntilText } from '../appointment/document-access';
import { RX_STATUS } from '../prescriptions/rx-shared';

/*
 * The doctor app's documents, described for the shared viewer (`@supadoc/viewer`).
 * Pure builders: the hosts open the viewer with what these return.
 *
 * This file (and, from the Lab batch, `lab/lab-viewer-sources.ts`) is the ONLY
 * place in the doctor app allowed to touch the view-only routes
 * (`patientDocumentView` / `viewResult`, apps/doctor/eslint.config.mjs): a
 * patient's document is only ever wrapped by `viewOnlySource`, so it is always
 * watermarked, audited on print and never downloadable.
 */

/** The key prefix of a patient document (`'doc:' + id`). */
export const PATIENT_DOC_KEY = 'doc:';

/** Who put a shared document there, as the appointment page's pill says it. */
export function patientDocOrigin(doc: Pick<DoctorSharedDocumentDto, 'uploader_role'>): string {
  return doc.uploader_role === 'patient' ? 'Patient upload' : 'Doctor-uploaded';
}

/**
 * A document the patient shares with you (appointment page, call): view-only,
 * watermarked, its print recorded first (the patient sees both), never
 * downloadable. "No longer shared" shows NOT_SHARED and calls `hooks.onGone`
 * (the host re-reads its list). `timeZone`: the doctor's, for "Shared until …".
 */
export function patientDocumentSource(
  api: Pick<DoctorApi, 'patientDocumentView' | 'patientDocumentPrinted'>,
  appointmentId: string,
  doc: DoctorSharedDocumentDto,
  hooks: { onGone(): void },
  timeZone?: string,
): ViewerSource {
  return viewOnlySource({
    key: PATIENT_DOC_KEY + doc.id,
    title: doc.title,
    typeLabel: doc.type_label,
    extension: doc.extension,
    sizeLabel: doc.size_label,
    meta: [patientDocOrigin(doc), sharedUntilText(doc, timeZone)].filter((p) => !!p),
    viewable: isViewableDoc(doc),
    view: () => api.patientDocumentView(appointmentId, doc.id),
    recordPrint: (viewRef) => api.patientDocumentPrinted(appointmentId, doc.id, viewRef),
    notSharedText: NOT_SHARED,
    onGone: () => hooks.onGone(),
  });
}

/** A prescription's status as its badge says it ("Active", "Expired"…); '' for an unknown one. */
function rxStatusLabel(status: string | null | undefined): string {
  return status && Object.hasOwn(RX_STATUS, status) ? RX_STATUS[status as PrescriptionStatus].label : '';
}

/**
 * A prescription's PDF (sent, active, expired, cancelled): Print and Download.
 * Each open mints one short-lived link (`prescription.viewed`) and fetches it
 * with HttpClient; Download mints a download link (`prescription.downloaded`).
 */
export function prescriptionSource(
  api: Pick<DoctorApi, 'prescriptionLink'>,
  files: Pick<PrescriptionsApi, 'fileBlob'>,
  rx: { readonly id: string; readonly number: string; readonly title?: string | null; readonly status?: string | null },
): ViewerSource {
  const status = rxStatusLabel(rx.status);
  return signedLinkSource({
    policy: 'authored',
    key: 'rx:' + rx.id,
    title: rx.title || `Prescription ${rx.number}`,
    typeLabel: 'Prescription',
    extension: 'pdf',
    meta: status ? [status] : [],
    link: (download) => api.prescriptionLink(rx.id, download).pipe(map((r) => r.data)),
    fetch: (url) => files.fileBlob({ url } as PrescriptionLinkDto),
  });
}

/**
 * The composer's "Preview PDF" (stamped DRAFT): Print, no Download (Q6). The
 * composer may have no saved prescription yet, so the source never captures
 * an id: `resolve` (save first when needed) runs inside `load()` — and again on
 * "Try again" — and the link is minted for whatever id it gives. `draftKey` is
 * per composer instance (`'rx-draft:' + n`), never `'rx:undefined'`.
 */
export function draftPrescriptionSource(
  api: Pick<DoctorApi, 'prescriptionLink'>,
  files: Pick<PrescriptionsApi, 'fileBlob'>,
  draftKey: string,
  resolve: () => Observable<{ readonly id: string }>,
  options: { readonly mapError?: (err: unknown) => ViewerErrorView | null } = {},
): ViewerSource {
  return signedLinkSource({
    policy: 'authored_draft',
    canDownload: false,
    key: draftKey,
    title: 'Draft prescription',
    typeLabel: 'Prescription',
    extension: 'pdf',
    link: () =>
      resolve().pipe(
        take(1),
        switchMap((rx) => api.prescriptionLink(rx.id)),
        map((r) => r.data),
      ),
    fetch: (url) => files.fileBlob({ url } as PrescriptionLinkDto),
    ...(options.mapError ? { mapError: options.mapError } : {}),
  });
}

/**
 * A referral letter or medical certificate, rendered by the API as a PDF
 * (`?format=pdf`): Print, no Download (D13: as the HTML tab had no download
 * control; nothing is saved). `doc.label`: the certificate's type label, or the
 * referral's target; `issued_at` is shown on the doctor's clock.
 */
export function clinicalDocumentSource(
  api: Pick<DoctorApi, 'documentPdf'>,
  appointmentId: string,
  kind: ClinicalDocumentKind,
  doc: { readonly id: string; readonly label?: string | null; readonly issued_at?: string | null },
  timeZone?: string,
): ViewerSource {
  const referral = kind === 'referral';
  const issued = doc.issued_at && timeZone ? formatInZone(doc.issued_at, timeZone, 'date') : '';
  const meta = [referral ? (doc.label ?? '') : '', issued ? `Issued ${issued}` : ''].filter((p) => !!p);
  return blobSource({
    policy: 'authored_print',
    key: `${kind}:${doc.id}`,
    title: referral ? 'Referral letter' : doc.label || 'Medical certificate',
    typeLabel: referral ? 'Referral' : 'Medical certificate',
    extension: 'pdf',
    meta,
    fetch: () => api.documentPdf(appointmentId, kind, doc.id),
  });
}

/** "licence.pdf" → "pdf"; '' when the name has none. */
function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/** One of the doctor's OWN licensing documents (not a patient's): View, Print and Download. */
export function credentialSource(
  api: Pick<DoctorApi, 'credentialFile'>,
  c: Pick<SpecialistCredentialDto, 'id' | 'type_label' | 'original_name'>,
): ViewerSource {
  return blobSource({
    policy: 'owner',
    key: 'cred:' + c.id,
    title: c.type_label,
    typeLabel: 'Licensing document',
    extension: extensionOf(c.original_name),
    meta: c.original_name ? [c.original_name] : [],
    filename: c.original_name || undefined,
    fetch: () => api.credentialFile(c.id),
  });
}

/**
 * The view-only watermark: the doctor's name and zone (`timeZone`: the call's
 * zone where it differs from the profile's). Never empty, or the viewer
 * refuses the document (§1.16).
 */
export function viewerWatermark(
  clock: { profile(): { readonly name?: string | null } | null; zone(): string },
  auth: { displayName(): string | null | undefined },
  timeZone?: string,
): ViewerWatermark {
  return {
    viewerName: clock.profile()?.name?.trim() || auth.displayName()?.trim() || 'Doctor',
    timeZone: timeZone || clock.zone(),
  };
}

/**
 * The patient stopped sharing (a poll, a refresh, realtime): every patient
 * document of the open viewer that `present` no longer has is revoked in place
 * — its bytes dropped at once, NOT_SHARED shown (role=alert) — whether it is on
 * screen or further along the list. Returns the ids revoked.
 */
export function revokeUnshared(
  viewer: Pick<DocumentViewerService, 'session' | 'revoke'>,
  present: ReadonlySet<string>,
): string[] {
  const gone: string[] = [];
  for (const src of viewer.session()?.sources ?? []) {
    if (!src.key.startsWith(PATIENT_DOC_KEY)) continue;
    const id = src.key.slice(PATIENT_DOC_KEY.length);
    if (present.has(id)) continue;
    viewer.revoke(src.key, NOT_SHARED);
    gone.push(id);
  }
  return gone;
}
