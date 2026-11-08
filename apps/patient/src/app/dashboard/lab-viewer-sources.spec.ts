import type { LabRequestsApi } from '@supadoc/data-access';
import type { LabRequestStatus } from '@supadoc/models';
import { of } from 'rxjs';
import { hasLabPdf, httpStatus, LAB_PDF_CHANGED, myLabRequestPdfSource, statusChanged } from './lab-viewer-sources';

describe('lab-viewer-sources', () => {
  const api = {
    myLink: vi.fn(() => of({ data: { url: '/api/public/lab-requests/file?token=t', expires_at: '', filename: '' } })),
    fileBlob: vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' }))),
  } as unknown as LabRequestsApi;
  const summary = { id: 'lr-1', number: 'GVM-REQ-20261101-00001', sent_at: '2026-11-01T15:30:00Z' };

  it('the request PDF: key lab:<id>, owner policy, its number in the title, "Sent …" in the meta', () => {
    const s = myLabRequestPdfSource(api, summary, () => undefined, 'Africa/Lagos');
    expect(s.key).toBe('lab:lr-1');
    expect(s.policy).toBe('owner');
    expect(s.title).toBe('Lab request GVM-REQ-20261101-00001');
    expect(s.typeLabel).toBe('Lab request');
    expect(s.extension).toBe('pdf');
    expect(s.meta).toEqual(['Sent Sun 1 Nov 2026']);
    expect(typeof s.download).toBe('function');
  });

  it('a 409 status_changed is gone (not retryable) with the changed copy; onGone is the host’s', () => {
    const onGone = vi.fn();
    const s = myLabRequestPdfSource(api, summary, onGone, 'Africa/Lagos');
    const changed = { statusCode: 409, errors: { code: 'status_changed', status: 'cancelled' } };
    expect(s.mapError?.(changed)).toEqual({ state: 'gone', text: LAB_PDF_CHANGED, retry: false });
    expect(s.mapError?.({ statusCode: 409, errors: { code: 'other' } })).toBeNull();
    expect(s.mapError?.({ statusCode: 500 })).toBeNull();
    s.onGone?.();
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('hasLabPdf: exactly booked, in_lab and result_ready among the seven statuses', () => {
    const all: LabRequestStatus[] = ['awaiting_consent', 'booked', 'in_lab', 'result_ready', 'declined', 'cancelled', 'expired'];
    expect(all.filter((status) => hasLabPdf({ status }))).toEqual(['booked', 'in_lab', 'result_ready']);
  });

  it('httpStatus reads either error shape; statusChanged needs both the 409 and the code', () => {
    expect(httpStatus({ statusCode: 409 })).toBe(409);
    expect(httpStatus({ status: 404 })).toBe(404);
    expect(httpStatus('nope')).toBeUndefined();
    expect(statusChanged({ statusCode: 409, errors: { code: 'status_changed' } })).toBe(true);
    expect(statusChanged({ statusCode: 422, errors: { code: 'status_changed' } })).toBe(false);
    expect(statusChanged({ statusCode: 409 })).toBe(false);
  });
});
