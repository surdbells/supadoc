import type { AdminLabRequestSummaryDto, LabRequestStatus } from '@supadoc/models';
import { firstValueFrom, of } from 'rxjs';
import { STAFF_PERMISSIONS } from '../staff/staff';
import {
  calendarDate,
  isReopen,
  LAB_STATUS_META,
  labCorrectionLabel,
  labPriorityLabel,
  labStatusMeta,
  sentLabel,
  staffLabRequestSource,
} from './lab-request-ui';

const ROW: Pick<AdminLabRequestSummaryDto, 'id' | 'number' | 'status' | 'doctor_name'> = {
  id: 'lab-1',
  number: 'GVM-REQ-20261104-00012',
  status: 'booked',
  doctor_name: 'Dr. James Smith',
};

describe('lab-request-ui', () => {
  it("uses the doctor portal's status labels, each with words and an icon", () => {
    const labels: Record<LabRequestStatus, string> = {
      awaiting_consent: 'Awaiting Consent',
      booked: 'Booked',
      in_lab: 'In Lab',
      result_ready: 'Result ready',
      declined: 'Declined',
      cancelled: 'Cancelled',
      expired: 'Expired',
    };
    for (const [status, label] of Object.entries(labels)) {
      const meta = LAB_STATUS_META[status as LabRequestStatus];
      expect(meta.label).toBe(label);
      expect(meta.icon).toBeTruthy();
      expect(meta.cls).toMatch(/^bg-/);
    }
    expect(labStatusMeta('result_ready').cls).toBe('bg-sage/10 text-sage-ink');
    expect(labStatusMeta('mystery').label).toBe('mystery');
  });

  it('never labels a staff row "abnormal" (staff rows carry no review outcome)', () => {
    for (const meta of Object.values(LAB_STATUS_META)) expect(meta.label.toLowerCase()).not.toContain('abnormal');
  });

  it('labels priorities and correction targets', () => {
    expect(labPriorityLabel('stat')).toBe('STAT');
    expect(labPriorityLabel('urgent')).toBe('Urgent');
    expect(labPriorityLabel('routine')).toBe('Routine');
    expect(labCorrectionLabel('in_lab')).toBe('In Lab (sample given)');
    expect(labCorrectionLabel('booked')).toBe('Booked');
    expect(labCorrectionLabel('awaiting_consent')).toBe('Awaiting Consent (reopen)');
  });

  it('a reopen is a declined or expired request going back to Booked / Awaiting Consent', () => {
    expect(isReopen('declined', 'awaiting_consent')).toBe(true);
    expect(isReopen('expired', 'booked')).toBe(true);
    expect(isReopen('expired', 'awaiting_consent')).toBe(true);
    expect(isReopen('booked', 'in_lab')).toBe(false);
    expect(isReopen('in_lab', 'booked')).toBe(false);
    expect(isReopen('declined', null)).toBe(false);
  });

  it('formats a calendar date from its parts, never through Date parsing', () => {
    expect(calendarDate('2026-12-04')).toBe('4 Dec 2026');
    expect(calendarDate('2026-01-31')).toBe('31 Jan 2026');
    expect(calendarDate(null)).toBe('—');
    expect(calendarDate('2026-13-01')).toBe('—');
    expect(calendarDate('4 Dec 2026')).toBe('—');
    // The same day whatever the zone: no Date object is built from it.
    const spy = vi.spyOn(Date, 'parse');
    expect(calendarDate('2026-11-04')).toBe('4 Nov 2026');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('shows the send time as a day and time, or a dash', () => {
    expect(sentLabel('2026-11-04T15:30:00Z')).toMatch(/^\d{1,2} Nov 2026, \d{1,2}:\d{2}$/);
    expect(sentLabel('')).toBe('—');
    expect(sentLabel('not a date')).toBe('—');
  });

  it('builds the staff request-PDF source: staff_record, view and print only, a view link on load', async () => {
    const api = {
      staffLink: vi.fn(() => of({ status: 'success', message: 'OK', data: { url: '/api/public/lab-requests/file?token=t', expires_at: '', filename: 'r.pdf' } })),
      fileBlob: vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' }))),
    };
    const source = staffLabRequestSource(api as never, ROW);
    expect(source).toMatchObject({
      key: 'lab:lab-1',
      title: 'Lab request GVM-REQ-20261104-00012',
      typeLabel: 'Lab request',
      extension: 'pdf',
      policy: 'staff_record',
      meta: ['Booked', 'Dr. James Smith'],
    });
    expect(source.download).toBeUndefined();
    expect(api.staffLink).not.toHaveBeenCalled();

    const file = await firstValueFrom(source.load());
    expect(api.staffLink).toHaveBeenCalledWith('lab-1', false);
    expect(api.fileBlob).toHaveBeenCalledWith({ url: '/api/public/lab-requests/file?token=t' });
    expect(file.mime).toBe('application/pdf');
  });

  it('the staff editor offers labs.manage (§5)', () => {
    expect(STAFF_PERMISSIONS).toContainEqual({ value: 'labs.manage', label: 'Manage lab requests (status, PDFs)' });
  });
});
