import { zoneOffsetMinutes } from '@supadoc/data-access';
import {
  applicantDateTime,
  applicationStatusBadge,
  clinicDateTime,
  clinicLocalToIso,
  countryName,
  defaultSort,
  documentTitle,
  isoToClinicLocal,
  meetingHost,
  openInfoRequest,
  routeBadge,
  routeSlots,
  slotLabel,
  viewerDateTime,
  viewerTimeDiffers,
  waitingLabel,
  waitingSince,
} from './application-ui';

describe('application-ui', () => {
  it('names every status with an icon (never colour alone)', () => {
    expect(applicationStatusBadge('submitted').label).toBe('New');
    expect(applicationStatusBadge('under_review').label).toBe('Under review');
    expect(applicationStatusBadge('more_info_needed').label).toBe('More info needed');
    expect(applicationStatusBadge('interview_scheduled')).toMatchObject({ label: 'Interview scheduled', icon: 'video' });
    expect(applicationStatusBadge('approved').icon).toBe('badge-check');
    expect(applicationStatusBadge('rejected').icon).toBe('circle-x');
    expect(applicationStatusBadge('withdrawn').label).toBe('Withdrawn');
  });

  it('labels the licence route, preferring the API label', () => {
    expect(routeBadge('ng', 'Nigeria · MDCN')).toMatchObject({ label: 'Nigeria · MDCN', icon: 'id-card' });
    expect(routeBadge('abroad', 'Abroad · United Kingdom')).toMatchObject({ label: 'Abroad · United Kingdom', icon: 'globe' });
    expect(routeBadge('abroad').label).toBe('Abroad');
  });

  it('works the needs-action queue oldest first, everything else newest first', () => {
    expect(defaultSort('needs_action')).toBe('waiting');
    expect(defaultSort('all')).toBe('newest');
    expect(defaultSort('approved')).toBe('newest');
  });

  it('lists the route’s document slots with their route wording', () => {
    expect(routeSlots('ng')[0]).toBe('mdcn_certificate');
    expect(routeSlots('abroad')[0]).toBe('good_standing_certificate');
    expect(routeSlots('ng')).toHaveLength(6);
    expect(slotLabel('practising_licence', 'ng')).toBe('Current MDCN practising licence');
    expect(slotLabel('practising_licence', 'abroad')).toBe('Current practising licence');
    expect(slotLabel('good_standing_certificate', 'abroad')).toBe('Certificate of Good Standing');
    expect(documentTitle({ slot: 'additional', slot_label: 'Another document', label: 'Specialist certificate' })).toBe('Specialist certificate');
    expect(documentTitle({ slot: 'government_id', slot_label: 'Government-issued ID', label: null })).toBe('Government-issued ID');
  });

  it('reads a datetime-local value as Lagos time, with its offset', () => {
    expect(clinicLocalToIso('2026-10-14T10:00')).toBe('2026-10-14T10:00:00+01:00');
    expect(clinicLocalToIso('2026-01-31T23:30')).toBe('2026-01-31T23:30:00+01:00');
    expect(new Date(clinicLocalToIso('2026-10-14T10:00') ?? '').toISOString()).toBe('2026-10-14T09:00:00.000Z');
    expect(clinicLocalToIso('')).toBeNull();
    expect(clinicLocalToIso('14/10/2026 10:00')).toBeNull();
  });

  it('follows a zone with a clock change (London, either side of the October change)', () => {
    expect(clinicLocalToIso('2026-10-14T10:00', 'Europe/London')).toBe('2026-10-14T10:00:00+01:00');
    expect(clinicLocalToIso('2026-11-14T10:00', 'Europe/London')).toBe('2026-11-14T10:00:00+00:00');
    expect(zoneOffsetMinutes(new Date('2026-07-01T12:00:00Z'), 'Africa/Lagos')).toBe(60);
  });

  it('turns an instant back into the clinic wall time, and says it as the applicant sees it', () => {
    expect(isoToClinicLocal('2026-10-14T09:00:00Z')).toBe('2026-10-14T10:00');
    expect(isoToClinicLocal('2026-10-14T23:30:00Z')).toBe('2026-10-15T00:30');
    expect(isoToClinicLocal(null)).toBe('');
    expect(clinicDateTime('2026-10-14T09:00:00Z')).toBe('Wed 14 Oct, 10:00 WAT');
  });

  it("shows the viewer's own time only when their clock differs", () => {
    expect(viewerTimeDiffers('2026-10-14T09:00:00Z', 'Africa/Lagos')).toBe(false);
    expect(viewerTimeDiffers('2026-10-14T09:00:00Z', 'Africa/Douala')).toBe(false);
    expect(viewerTimeDiffers('2026-10-14T09:00:00Z', 'Europe/London')).toBe(false);
    expect(viewerTimeDiffers('2026-11-14T09:00:00Z', 'Europe/London')).toBe(true);
    expect(viewerTimeDiffers('2026-10-14T09:00:00Z', 'America/New_York')).toBe(true);
    expect(viewerDateTime('2026-10-14T09:00:00Z', 'America/New_York')).toBe('Wed 14 Oct, 05:00 EDT');
    expect(viewerDateTime('2026-12-14T09:00:00Z', 'Europe/London')).toBe('Mon 14 Dec, 09:00 GMT');
    expect(viewerDateTime(null)).toBe('—');
  });

  it("gives the applicant's own time only when their zone is set and differs from WAT", () => {
    // 10:00 WAT on Wed 14 Oct 2026 is 4:00 AM in Chicago (CDT).
    expect(applicantDateTime('2026-10-14T09:00:00Z', 'America/Chicago')).toBe('Wed 14 Oct, 4:00 AM CDT (America/Chicago)');
    // Across midnight the applicant's own date is used.
    expect(applicantDateTime('2026-10-14T09:00:00Z', 'Pacific/Honolulu')).toBe('Tue 13 Oct, 11:00 PM HST (Pacific/Honolulu)');
    // Same offset as Lagos at that instant (London on BST, Douala): nothing to add.
    expect(applicantDateTime('2026-10-14T09:00:00Z', 'Europe/London')).toBeNull();
    expect(applicantDateTime('2026-10-14T09:00:00Z', 'Africa/Douala')).toBeNull();
    expect(applicantDateTime('2026-10-14T09:00:00Z', null)).toBeNull();
    expect(applicantDateTime('2026-10-14T09:00:00Z', 'Not/AZone')).toBeNull();
    expect(applicantDateTime('', 'America/Chicago')).toBeNull();
  });

  it('accepts only full https meeting links', () => {
    expect(meetingHost('https://meet.google.com/abc-defg-hij')).toBe('meet.google.com');
    expect(meetingHost('  https://us02web.zoom.us/j/123?pwd=x ')).toBe('us02web.zoom.us');
    expect(meetingHost('http://meet.google.com/abc')).toBeNull();
    expect(meetingHost('javascript:alert(1)')).toBeNull();
    expect(meetingHost('https://user:pass@meet.example.com/x')).toBeNull();
    expect(meetingHost('https://localhost/x')).toBeNull();
    expect(meetingHost('meet.google.com/abc')).toBeNull();
    expect(meetingHost('https://a.co/' + 'x'.repeat(500))).toBeNull();
  });

  it('counts the wait from the latest reply, else the submission', () => {
    const now = new Date('2026-10-23T12:00:00Z');
    expect(waitingLabel('2026-10-23T08:00:00Z', now)).toBe('Waiting since today');
    expect(waitingLabel('2026-10-22T08:00:00Z', now)).toBe('Waiting 1 day');
    expect(waitingLabel('2026-10-18T08:00:00Z', now)).toBe('Waiting 5 days');
    const since = waitingSince({
      submitted_at: '2026-10-10T08:00:00Z',
      info_requests: [
        { id: 'r1', message: 'm', items: [], requested_at: '2026-10-12T08:00:00Z', responded_at: '2026-10-15T08:00:00Z', response_note: null },
      ],
    });
    expect(since).toBe('2026-10-15T08:00:00Z');
  });

  it('finds the open info request', () => {
    const answered = { id: 'r1', message: 'm', items: [], requested_at: 'a', responded_at: 'b', response_note: null };
    const closed = { ...answered, id: 'r2', responded_at: null, closed_at: 'c', close_reason: 'rejected' as const };
    const open = { ...answered, id: 'r3', responded_at: null, closed_at: null };
    expect(openInfoRequest([answered, closed])).toBeNull();
    expect(openInfoRequest([answered, closed, open])?.id).toBe('r3');
  });

  it('names countries in English', () => {
    expect(countryName('GB')).toBe('United Kingdom');
    expect(countryName('ng')).toBe('Nigeria');
    expect(countryName('')).toBe('—');
  });
});
