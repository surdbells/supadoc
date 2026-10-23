import {
  addDays,
  clinicToday,
  formatBytes,
  formatDateLong,
  formatDayMonthYear,
  formatPhone,
  goodStandingMinDate,
  maskEmail,
  maskPhone,
  minusYears,
  parseYmd,
} from './format';

describe('format', () => {
  it('masks emails to the first 3 characters of the local part', () => {
    expect(maskEmail('clementolawunmi@gmail.com')).toBe('cle***@gmail.com');
    expect(maskEmail('ab@x.io')).toBe('ab***@x.io');
    expect(maskEmail('not-an-email')).toBe('');
  });

  it('masks Nigerian and international phones', () => {
    expect(maskPhone('+2348021234556')).toBe('0802*****56');
    expect(maskPhone('+447700900123')).toBe('+44 77*****23');
    expect(maskPhone('')).toBe('');
  });

  it('formats phones for display', () => {
    expect(formatPhone('+2348031234567')).toBe('+234 803 123 4567');
    expect(formatPhone('+447700900123')).toBe('+44 7700900123');
    expect(formatPhone('+12025550143')).toBe('+1 2025550143');
    expect(formatPhone('08031234567')).toBe('08031234567');
  });

  it('formats dates', () => {
    expect(formatDateLong('1985-03-12')).toBe('12 Mar 1985');
    expect(formatDayMonthYear('2026-04-21')).toBe('21 April 2026');
    expect(formatDayMonthYear('2026-03-03')).toBe('3 March 2026');
    expect(formatDateLong('nope')).toBe('');
    expect(parseYmd('2026-02-30')).toBeNull();
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3 * 1024)).toBe('3 KB');
    expect(formatBytes(1.2 * 1024 * 1024)).toBe('1.2 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
  });

  it('computes the Good Standing window, clamped to the month end', () => {
    expect(goodStandingMinDate('2026-10-23')).toBe('2026-04-23');
    expect(goodStandingMinDate('2026-08-31')).toBe('2026-02-28');
    expect(goodStandingMinDate('2028-08-31')).toBe('2028-02-29');
    expect(goodStandingMinDate('2026-03-15')).toBe('2025-09-15');
  });

  it('does date arithmetic on the calendar', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(minusYears('2026-10-23', 21)).toBe('2005-10-23');
    expect(minusYears('2028-02-29', 1)).toBe('2027-02-28');
  });

  it('takes today on the Lagos calendar', () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Lagos (UTC+1).
    expect(clinicToday(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
  });
});
