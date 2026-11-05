import type { HttpResponse } from '@angular/common/http';
import type { PatientDocumentView } from './doctor.api';

/** A view reference the API issues per view: "VM-" + 8 upper-case hex digits. */
export const VIEW_REF_PATTERN = /^VM-[0-9A-F]{8}$/;

/**
 * The view-only document response (a patient document or a lab result fetched
 * with `X-SD-Viewer: 1`) as the viewer needs it:
 * - `mime`: the served `Content-Type`, lower-case and without parameters (else the blob's type);
 * - `viewRef`: `X-SD-View-Ref` when well-formed, else null (an older API sends none);
 * - `viewedAt`: `X-SD-Viewed-At` when it parses as a date, else `now()`.
 *
 * Shared by `DoctorApi.patientDocumentView` and `LabRequestsApi.viewResult`.
 */
export function parseDocumentView(res: HttpResponse<Blob>, now: () => Date = () => new Date()): PatientDocumentView {
  const blob = res.body ?? new Blob([]);
  const type = (res.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  const ref = (res.headers.get('X-SD-View-Ref') ?? '').trim();
  const at = res.headers.get('X-SD-Viewed-At');
  const atMs = at ? Date.parse(at) : NaN;
  return {
    blob,
    mime: type || blob.type,
    viewRef: VIEW_REF_PATTERN.test(ref) ? ref : null,
    viewedAt: Number.isFinite(atMs) && at ? at : now().toISOString(),
  };
}
