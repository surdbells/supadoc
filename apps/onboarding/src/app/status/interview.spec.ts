import { interviewLabel } from './interview';

/** Wednesday 14 October 2026, 10:00 WAT (09:00 UTC). */
const OCT = '2026-10-14T10:00:00+01:00';

describe('interviewLabel', () => {
  it('stays in clinic time when the viewer reads the same as WAT', () => {
    expect(interviewLabel(OCT, 'Africa/Lagos')).toBe('Wednesday 14 October, 10:00 WAT · video call');
    expect(interviewLabel(OCT, 'Africa/Douala')).toBe('Wednesday 14 October, 10:00 WAT · video call');
    // London keeps WAT's offset in October (BST).
    expect(interviewLabel(OCT, 'Europe/London')).toBe('Wednesday 14 October, 10:00 WAT · video call');
  });

  it("leads with the viewer's own time when it differs", () => {
    expect(interviewLabel(OCT, 'America/Chicago')).toBe(
      'Wednesday 14 October, 4:00 AM CDT your time · 10:00 WAT VideoMed time · video call',
    );
    expect(interviewLabel(OCT, 'America/New_York')).toBe(
      'Wednesday 14 October, 5:00 AM EDT your time · 10:00 WAT VideoMed time · video call',
    );
    // In December London is an hour behind Lagos.
    expect(interviewLabel('2026-12-14T10:00:00+01:00', 'Europe/London')).toBe(
      'Monday 14 December, 9:00 AM GMT your time · 10:00 WAT VideoMed time · video call',
    );
    // A zone outside the shared table reads as its offset.
    expect(interviewLabel(OCT, 'Asia/Dubai')).toBe(
      'Wednesday 14 October, 1:00 PM GMT+4 your time · 10:00 WAT VideoMed time · video call',
    );
  });

  it("names the clinic's day when the dates differ", () => {
    expect(interviewLabel(OCT, 'Pacific/Honolulu')).toBe(
      'Tuesday 13 October, 11:00 PM HST your time · Wed 14 Oct, 10:00 WAT VideoMed time · video call',
    );
  });

  it('is plain ASCII apart from the separators (no locale spaces before AM/PM)', () => {
    expect(interviewLabel(OCT, 'America/Chicago')).not.toMatch(new RegExp(`[${String.fromCharCode(0x202f, 0xa0)}]`));
  });

  it('is empty for a bad instant, and falls back to clinic time for an unknown zone', () => {
    expect(interviewLabel('not a date', 'America/Chicago')).toBe('');
    expect(interviewLabel(OCT, 'Not/AZone')).toBe('Wednesday 14 October, 10:00 WAT · video call');
  });
});
