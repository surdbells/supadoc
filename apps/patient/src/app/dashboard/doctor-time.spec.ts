import { doctorClock, doctorTimeLabel, doctorTimeWho } from './doctor-time';

const LAGOS = 'Africa/Lagos';

describe("the doctor's time beside the patient's", () => {
  it("is the doctor's clock only when the offsets differ at that instant", () => {
    // 4:00 PM WAT is 9:00 AM CST (Chicago on standard time from 1 Nov 2026).
    expect(doctorClock('2026-11-04T15:00:00Z', 'America/Chicago', LAGOS)).toBe('9:00 AM CST');
    expect(doctorClock('2026-11-04T15:00:00Z', LAGOS, LAGOS)).toBeNull();
    // Same offset, different zone (Douala is WAT too): nothing to add.
    expect(doctorClock('2026-11-04T15:00:00Z', 'Africa/Douala', LAGOS)).toBeNull();
  });

  it('adds the weekday when the doctor is on another date', () => {
    // Thu 4:00 AM WAT is still Wednesday 9:00 PM in Chicago.
    expect(doctorClock('2026-11-05T03:00:00Z', 'America/Chicago', LAGOS)).toBe('Wed 9:00 PM CST');
  });

  it('shows nothing for an older API (no zone), an unknown zone or a bad instant', () => {
    expect(doctorClock('2026-11-04T15:00:00Z', undefined, LAGOS)).toBeNull();
    expect(doctorClock('2026-11-04T15:00:00Z', 'Not/AZone', LAGOS)).toBeNull();
    expect(doctorClock('', 'America/Chicago', LAGOS)).toBeNull();
    expect(doctorClock('not a date', 'America/Chicago', LAGOS)).toBeNull();
  });

  it('labels it with the doctor\'s short name: "9:00 AM CST Dr Smith\'s time"', () => {
    expect(doctorTimeLabel('2026-11-04T15:00:00Z', { name: 'John Smith', timezone: 'America/Chicago' }, LAGOS)).toBe(
      "9:00 AM CST Dr Smith's time",
    );
    expect(doctorTimeLabel('2026-11-04T15:00:00Z', { name: 'John Smith', timezone: LAGOS }, LAGOS)).toBeNull();
    expect(doctorTimeWho('Dr. Ada Obi')).toBe("Dr Obi's time");
    expect(doctorTimeWho('')).toBe("the doctor's time");
    expect(doctorTimeWho('Bayo Adams')).toBe("Dr Adams' time");
  });
});
