import { formatInZone } from '@supadoc/data-access';
import {
  ageSex,
  calendarDate,
  drName,
  fastingWarning,
  firstName,
  LAB_ABNORMAL_META,
  LAB_GROUPS,
  LAB_PRIORITY_META,
  LAB_STATUS_META,
  labDayLabel,
  labStatusMeta,
  numberParts,
  previousDay,
  showsAbnormalCaption,
  specimenText,
} from './lab-ui';

/** A doctor's clock in a fixed zone, "now" pinned. */
function clockIn(zone: string, now: string) {
  return {
    ymd: (at: string) => formatInZone(at, zone, 'ymd'),
    today: () => formatInZone(now, zone, 'ymd'),
    shortDate: (at: string) => formatInZone(at, zone, 'date').replace(/^[A-Z][a-z]{2} /, ''),
  };
}

describe('lab-ui', () => {
  it('maps every status to a chip whose text names it', () => {
    expect(labStatusMeta({ status: 'awaiting_consent', abnormal: false })).toEqual({
      label: 'Awaiting Consent',
      cls: 'bg-warning/10 text-warning-ink',
    });
    expect(labStatusMeta({ status: 'booked', abnormal: false }).label).toBe('Booked');
    expect(labStatusMeta({ status: 'in_lab', abnormal: false })).toEqual({ label: 'In Lab', cls: 'bg-teal/10 text-teal-ink' });
    expect(labStatusMeta({ status: 'result_ready', abnormal: false })).toEqual({ label: 'Result ready', cls: 'bg-sage/10 text-sage-ink' });
    for (const s of ['declined', 'cancelled', 'expired'] as const) {
      expect(LAB_STATUS_META[s].cls).toBe('bg-cloud text-slate');
    }
  });

  it('reads "Result ready · Abnormal" once a result is reviewed abnormal', () => {
    expect(labStatusMeta({ status: 'result_ready', abnormal: true })).toBe(LAB_ABNORMAL_META);
    expect(LAB_ABNORMAL_META).toEqual({ label: 'Result ready · Abnormal', cls: 'bg-alert/10 text-alert-ink' });
  });

  it('keeps "Cancelled" for a cancelled request with an abnormal result, and says so underneath', () => {
    expect(labStatusMeta({ status: 'cancelled', abnormal: true }).label).toBe('Cancelled');
    expect(showsAbnormalCaption({ status: 'cancelled', abnormal: true })).toBe(true);
    expect(showsAbnormalCaption({ status: 'result_ready', abnormal: true })).toBe(false);
    expect(showsAbnormalCaption({ status: 'cancelled', abnormal: false })).toBe(false);
  });

  it('colours the priority words', () => {
    expect(LAB_PRIORITY_META.stat).toEqual({ label: 'STAT', cls: 'text-alert-ink' });
    expect(LAB_PRIORITY_META.urgent).toEqual({ label: 'Urgent', cls: 'text-warning-ink' });
    expect(LAB_PRIORITY_META.routine).toEqual({ label: 'Routine', cls: 'text-cerulean-dark' });
    expect(LAB_GROUPS.map((g) => g.label)).toEqual(['All', 'Awaiting patient', 'In progress', 'Result ready']);
  });

  it('labDayLabel: Today / Yesterday across the doctor’s midnight (Chicago), not UTC’s', () => {
    // Now: 06:10 UTC on 5 Nov = 00:10 on 5 Nov in Chicago (CST, UTC-6).
    const chicago = clockIn('America/Chicago', '2026-11-05T06:10:00Z');
    expect(labDayLabel('2026-11-05T06:05:00Z', chicago)).toBe('Today'); // 00:05 on the 5th
    expect(labDayLabel('2026-11-05T05:50:00Z', chicago)).toBe('Yesterday'); // 23:50 on the 4th (UTC says the 5th)
    expect(labDayLabel('2026-11-04T03:00:00Z', chicago)).toBe('3 Nov 2026'); // 21:00 on the 3rd
  });

  it('labDayLabel uses the doctor clock, not UTC', () => {
    const chicago = clockIn('America/Chicago', '2026-11-05T05:30:00Z'); // 4 Nov, 23:30 in Chicago
    expect(labDayLabel('2026-11-04T15:00:00Z', chicago)).toBe('Today'); // 09:00 on the 4th
    expect(labDayLabel('2026-11-04T03:00:00Z', chicago)).toBe('Yesterday'); // 21:00 on the 3rd
    expect(labDayLabel('2026-10-22T15:00:00Z', chicago)).toBe('22 Oct 2026');
    // The same instant on a Lagos clock is already the 5th.
    const lagos = clockIn('Africa/Lagos', '2026-11-05T05:30:00Z');
    expect(labDayLabel('2026-11-04T15:00:00Z', lagos)).toBe('Yesterday');
    expect(labDayLabel(null, chicago)).toBe('');
  });

  it('calendarDate prints the Y-m-d parts with no zone conversion', () => {
    expect(calendarDate('2026-12-04')).toBe('4 Dec 2026');
    expect(calendarDate('2026-01-31')).toBe('31 Jan 2026');
    expect(calendarDate('2026-13-01')).toBe('');
    expect(calendarDate('4 Dec 2026')).toBe('');
    expect(calendarDate(null)).toBe('');
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
    expect(previousDay('2027-01-01')).toBe('2026-12-31');
  });

  it('ageSex leaves out unknown parts', () => {
    expect(ageSex(55, 'Male')).toBe('55 years · Male');
    expect(ageSex(1, 'Female')).toBe('1 year · Female');
    expect(ageSex(null, 'Female')).toBe('Female');
    expect(ageSex(34, null)).toBe('34 years');
    expect(ageSex(null, null)).toBe('');
  });

  it('fastingWarning, drName and firstName', () => {
    expect(fastingWarning('Lipid profile', 10)).toBe('Lipid profile usually needs 10 hours of fasting.');
    expect(drName('James Smith')).toBe('Dr. James Smith');
    expect(drName('Dr. James Smith')).toBe('Dr. James Smith');
    expect(firstName('Chika Osuji')).toBe('Chika');
  });

  it('numberParts cuts a request number after each hyphen (a <wbr> goes after each part)', () => {
    expect(numberParts('GVM-REQ-20261105-00001')).toEqual(['GVM-', 'REQ-', '20261105-', '00001']);
    expect(numberParts('GVM-REQ-20261105-00001').join('')).toBe('GVM-REQ-20261105-00001');
    expect(numberParts('ABC')).toEqual(['ABC']);
    expect(numberParts('')).toEqual([]);
    expect(numberParts(null)).toEqual([]);
  });

  it('specimenText keeps one colon per label: value pair', () => {
    expect(specimenText('Venous blood: serum')).toBe('Venous blood (serum)');
    expect(specimenText('Venous blood: plasma (EDTA)')).toBe('Venous blood (plasma, EDTA)');
    expect(specimenText('Whole blood (EDTA)')).toBe('Whole blood (EDTA)');
    expect(specimenText('Blood culture bottles')).toBe('Blood culture bottles');
  });
});
