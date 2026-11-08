import { apiErrorCode, apiErrorMessage, type LabRequestsApi, viewerTimeZone } from '@supadoc/data-access';
import type { LabRequestLinkDto, PatientLabRequestDto, PatientLabRequestSummaryDto } from '@supadoc/models';
import { safeFilename, signedLinkSource, type ViewerSource } from '@supadoc/viewer';
import { map } from 'rxjs';
import { labDay } from './lab-ui';

/*
 * The patient's lab request PDF as a shared-viewer source, for the request's
 * page and the call page's notes. Its own small file: importing it from the
 * request page would pull that whole page into the call's chunk.
 */

/** The viewer's copy when the request changed under it (409 `status_changed`). */
export const LAB_PDF_CHANGED =
  'This request has changed. Close the viewer to see its status.';

/** HTTP status from either error shape (normalised `ApiError.statusCode` or raw `status`). */
export function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
}

/** A 409 `status_changed`: the request isn't (or is no longer) in a state that has a PDF. */
export function statusChanged(err: unknown): boolean {
  return httpStatus(err) === 409 && apiErrorCode(err) === 'status_changed';
}

/**
 * The request PDF exists for the patient (consented and in one of these
 * states; LabRequestPresenter.php:317 also allows `expired`, which the summary
 * can't tell apart from never-accepted).
 */
export const hasLabPdf = (r: Pick<PatientLabRequestSummaryDto, 'status'>): boolean =>
  r.status === 'booked' || r.status === 'in_lab' || r.status === 'result_ready';

/**
 * The request PDF in the shared viewer (owner policy: View, Print, Download).
 * A signed link per open (one `lab_request.viewed` row); Download mints a
 * download link (one `lab_request.downloaded` row). A 409 `status_changed`
 * (not accepted yet, or cancelled / expired meanwhile) is not retryable: the
 * viewer says so and `onGone` reloads the request.
 */
export function myLabRequestPdfSource(
  api: LabRequestsApi,
  r: Pick<PatientLabRequestDto, 'id' | 'number' | 'sent_at'>,
  onGone: () => void,
  zone = viewerTimeZone(),
): ViewerSource {
  const title = 'Lab request ' + r.number;
  const sent = labDay(r.sent_at, zone);
  return signedLinkSource({
    key: 'lab:' + r.id,
    policy: 'owner',
    title,
    typeLabel: 'Lab request',
    extension: 'pdf',
    meta: sent ? [`Sent ${sent}`] : [],
    link: (download) =>
      api
        .myLink(r.id, download)
        .pipe(
          map((res) => ({
            url: res.data.url,
            filename: res.data.filename || safeFilename(title, 'pdf'),
          })),
        ),
    fetch: (url) => api.fileBlob({ url } as LabRequestLinkDto),
    mapError: (err) =>
      statusChanged(err)
        ? {
            state: 'gone',
            text: apiErrorMessage(err, LAB_PDF_CHANGED),
            retry: false,
          }
        : null,
    onGone,
  });
}
