import type { LabRequestsApi } from '@supadoc/data-access';
import type { DoctorLabResultDto, LabRequestLinkDto } from '@supadoc/models';
import { signedLinkSource, type ViewerErrorView, type ViewerSource, viewOnlySource } from '@supadoc/viewer';
import { map } from 'rxjs';
import { httpStatusOf } from './lab-ui';

/*
 * Lab documents, described for the shared viewer (`@supadoc/viewer`). This is
 * the ONLY lab file the doctor app's download guard lets reference the
 * view-only result route (`viewResult`, apps/doctor/eslint.config.mjs): a
 * patient's result is only ever wrapped by `viewOnlySource`, so it is always
 * watermarked, audited on print and never downloadable.
 */

/** "No longer shared" copy for a result (the patient stopped sharing it). */
export const RESULT_NOT_SHARED = 'This result is no longer shared with you.';
/** 503 `view_unavailable` copy for a result. */
export const RESULT_UNAVAILABLE = "Couldn't open the result right now. Try again.";

/** The key prefix of a lab result in the viewer (`'labres:' + id`). */
export const LAB_RESULT_KEY = 'labres:';

/** A result the requesting doctor can open now (visible and an openable type). */
export function isOpenableResult(r: DoctorLabResultDto): r is DoctorLabResultDto & { document: NonNullable<DoctorLabResultDto['document']> } {
  return !!r.visible && !!r.document && !!r.document.viewable;
}

/** 503 → the lab copy; everything else → the viewer's default mapping. */
export function labResultError(err: unknown): ViewerErrorView | null {
  return httpStatusOf(err) === 503 ? { state: 'error', text: RESULT_UNAVAILABLE, retry: true } : null;
}

/**
 * A patient's lab result, view-only: fetched with `X-SD-Viewer: 1` (recorded
 * for the patient), every print recorded first, never downloadable. "No longer
 * shared" shows {@link RESULT_NOT_SHARED} and calls `hooks.onGone` (the page
 * reloads the request).
 */
export function labResultSource(
  labApi: Pick<LabRequestsApi, 'viewResult' | 'resultPrinted'>,
  labId: string,
  r: DoctorLabResultDto,
  hooks: { onGone(): void },
): ViewerSource {
  const doc = r.document;
  return viewOnlySource({
    key: LAB_RESULT_KEY + r.id,
    title: doc?.title || 'Lab result',
    typeLabel: doc?.type_label || 'Lab result',
    extension: doc?.extension ?? null,
    sizeLabel: doc?.size_label ?? null,
    viewable: !!doc?.viewable,
    view: () => labApi.viewResult(labId, r.id),
    recordPrint: (viewRef) => labApi.resultPrinted(labId, r.id, viewRef),
    notSharedText: RESULT_NOT_SHARED,
    mapError: labResultError,
    onGone: () => hooks.onGone(),
  });
}

/**
 * The signed request PDF (any status; a NOT YET ACCEPTED watermark until the
 * patient consents): Print and Download. Each open mints one short-lived link
 * (`lab_request.viewed`); Download mints a download link (`lab_request.downloaded`).
 */
export function labRequestPdfSource(
  labApi: Pick<LabRequestsApi, 'link' | 'fileBlob'>,
  lab: { readonly id: string; readonly number: string },
): ViewerSource {
  return signedLinkSource({
    policy: 'authored',
    key: 'lab:' + lab.id,
    title: 'Lab request ' + lab.number,
    typeLabel: 'Lab request',
    extension: 'pdf',
    link: (dl) => labApi.link(lab.id, dl).pipe(map((r) => r.data)),
    fetch: (u) => labApi.fileBlob({ url: u } as LabRequestLinkDto),
  });
}
