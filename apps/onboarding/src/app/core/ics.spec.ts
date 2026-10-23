import { buildInterviewIcs, escapeIcsText } from './ics';

describe('buildInterviewIcs', () => {
  const ics = buildInterviewIcs({
    startsAtUtc: '2026-10-14T10:00:00+01:00',
    minutes: 30,
    url: 'https://meet.google.com/abc-defg-hij',
    reference: 'GVM-DR-2026-12345',
    now: new Date('2026-10-01T08:00:00Z'),
  });

  it('starts and ends in UTC', () => {
    expect(ics).toContain('DTSTART:20261014T090000Z\r\n');
    expect(ics).toContain('DTEND:20261014T093000Z\r\n');
    expect(ics).toContain('DTSTAMP:20261001T080000Z\r\n');
  });

  it('uses CRLF line endings throughout', () => {
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
  });

  it('escapes text values', () => {
    expect(escapeIcsText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    expect(ics).toContain('LOCATION:https://meet.google.com/abc-defg-hij');
  });

  it('folds lines longer than 75 octets', () => {
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });

  it('refuses an invalid start', () => {
    expect(() => buildInterviewIcs({ startsAtUtc: 'nope', minutes: 30, url: 'https://x.y', reference: 'R' })).toThrow();
  });
});
