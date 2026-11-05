import type { AppointmentsApi, DocumentsApi, PrescriptionsApi } from '@supadoc/data-access';
import type {
  ClinicalDocumentKind,
  MedicalDocumentDto,
  PatientLabResultDto,
  PrescriptionLinkDto,
  PrescriptionStatus,
} from '@supadoc/models';
import { blobSource, safeFilename, signedLinkSource, type ViewerSource } from '@supadoc/viewer';
import { map } from 'rxjs';

/*
 * The patient's documents as shared-viewer sources (spec §6.2). Everything the
 * patient opens is their own record, so every source is policy `owner`: View,
 * Print and Download. Pure builders: no injection, no request until the viewer
 * calls `load()`. Imported only by lazily loaded pages (never by app.config /
 * app.ts), so `@supadoc/viewer` stays out of the initial bundle.
 */

/** The zone every patient date uses: the device's. */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "3 Nov 2026" in `zone` ('' when the date can't be read). */
export function viewerDate(iso: string | null | undefined, zone: string): string {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: zone }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }
}

/** `YYYY-MM-DD` of an instant in `zone` ('' when the date can't be read). */
export function ymdIn(iso: string | null | undefined, zone: string): string {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: zone }).formatToParts(d);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  }
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * The control a click came from, as the viewer's `opener`: focus returns to it
 * when the viewer closes (a button clicked in Safari never takes focus, so
 * `document.activeElement` would be the body). A component host such as
 * `sd-button` gives its own button.
 */
export function openerOf(event: Event | null | undefined): HTMLElement | null {
  const el = event?.currentTarget;
  if (typeof HTMLElement === 'undefined' || !(el instanceof HTMLElement)) return null;
  if (el.matches('button, a[href], [tabindex]')) return el;
  return el.querySelector<HTMLElement>('button, a[href]') ?? el;
}

/** Who uploaded a document, as the Documents page's badge says it. */
export function uploaderLabel(role: MedicalDocumentDto['uploader_role'] | string): string {
  return role === 'patient' ? 'Patient-upload' : role === 'doctor' ? 'Doctor-uploaded' : 'Staff-uploaded';
}

/** The fields of a library document the viewer needs (MedicalDocumentDto and its sharing variants). */
export type ViewerDocument = Pick<
  MedicalDocumentDto,
  'id' | 'title' | 'type_label' | 'extension' | 'size_label' | 'created_at' | 'uploader_role'
>;

/**
 * One of the patient's library documents (own uploads, doctor- and
 * staff-uploaded files, booking attachments): fetched as a Blob through the
 * authenticated route, saved under a name built here (the API's
 * Content-Disposition is not readable cross-origin).
 */
export function myDocumentSource(api: DocumentsApi, d: ViewerDocument, zone: string): ViewerSource {
  const added = viewerDate(d.created_at, zone);
  const meta = [added ? `Added ${added}` : '', d.uploader_role === 'patient' ? '' : uploaderLabel(d.uploader_role)].filter(Boolean);
  return blobSource({
    key: 'doc:' + d.id,
    policy: 'owner',
    title: d.title,
    typeLabel: d.type_label,
    extension: d.extension,
    sizeLabel: d.size_label,
    meta,
    filename: safeFilename(d.title, d.extension),
    fetch: () => api.fileBlob(d.id),
  });
}

/** The prescription fields the viewer needs (summary or full). */
export interface ViewerPrescription {
  readonly id: string;
  readonly number: string;
  readonly status: PrescriptionStatus;
  readonly sent_at: string | null;
  readonly created_at: string;
}

const RX_STATUS_META: Partial<Record<PrescriptionStatus, string>> = { expired: 'Expired', cancelled: 'Cancelled' };

/**
 * A sent prescription: a short-lived signed link minted per open (one
 * `prescription.viewed` row) and fetched as a Blob with HttpClient; Download
 * mints a download link (one `prescription.downloaded` row) — never a
 * cross-origin `<a href>`, which would navigate the page on an error body.
 */
export function myPrescriptionSource(rxApi: PrescriptionsApi, rx: ViewerPrescription, zone = deviceZone()): ViewerSource {
  const issued = viewerDate(rx.sent_at ?? rx.created_at, zone);
  const meta = [issued ? `Issued ${issued}` : '', RX_STATUS_META[rx.status] ?? ''].filter(Boolean);
  return signedLinkSource({
    key: 'rx:' + rx.id,
    policy: 'owner',
    title: 'Prescription ' + rx.number,
    typeLabel: 'Prescription',
    extension: 'pdf',
    meta,
    link: (download) =>
      rxApi.link(rx.id, download).pipe(
        map((r) => ({ url: r.data.url, filename: r.data.filename || safeFilename('Prescription ' + rx.number, 'pdf') })),
      ),
    fetch: (url) => rxApi.fileBlob({ url } as PrescriptionLinkDto),
  });
}

/** A referral letter or medical certificate of a consultation, as the page lists it. */
export interface ViewerClinicalDocument {
  readonly id: string;
  /** The row's title, e.g. "Referral · Cardiology" or "Sick leave certificate". */
  readonly title: string;
  /** When it was issued (the record's `created_at`). */
  readonly issued_at: string;
}

const CLINICAL: Record<ClinicalDocumentKind, { readonly typeLabel: string; readonly file: string }> = {
  referral: { typeLabel: 'Referral letter', file: 'referral' },
  certificate: { typeLabel: 'Medical certificate', file: 'medical-certificate' },
};

/**
 * A referral or certificate as the server-rendered PDF (`?format=pdf`), with
 * its text layer (screen readers read it). The download name is
 * `referral-YYYY-MM-DD.pdf` / `medical-certificate-YYYY-MM-DD.pdf`, dated in the
 * device zone (the server's own name, in the doctor's zone, is not readable
 * cross-origin; near midnight the two can differ by a day — only a file name).
 */
export function myClinicalDocumentSource(
  appointments: AppointmentsApi,
  appointmentId: string,
  kind: ClinicalDocumentKind,
  doc: ViewerClinicalDocument,
  zone = deviceZone(),
): ViewerSource {
  const c = CLINICAL[kind];
  const issued = viewerDate(doc.issued_at, zone);
  const ymd = ymdIn(doc.issued_at, zone);
  return blobSource({
    key: `${kind}:${doc.id}`,
    policy: 'owner',
    title: doc.title,
    typeLabel: c.typeLabel,
    extension: 'pdf',
    meta: issued ? [`Issued ${issued}`] : [],
    filename: ymd ? `${c.file}-${ymd}.pdf` : `${c.file}.pdf`,
    fetch: () => appointments.documentPdf(appointmentId, kind, doc.id),
  });
}

/**
 * A lab result file (Lab PATIENT wave): the result's document, which has no
 * `created_at`, uploader or `viewable` of its own, so `myDocumentSource` can't
 * take it.
 */
export function myLabResultSource(api: DocumentsApi, r: PatientLabResultDto, zone: string): ViewerSource {
  const added = viewerDate(r.uploaded_at, zone);
  return blobSource({
    key: 'doc:' + r.document.id,
    policy: 'owner',
    title: r.document.title,
    typeLabel: r.document.type_label,
    extension: r.document.extension,
    sizeLabel: r.document.size_label,
    viewable: r.viewable,
    meta: added ? [`Added ${added}`] : [],
    filename: safeFilename(r.document.title, r.document.extension),
    fetch: () => api.fileBlob(r.document.id),
  });
}
