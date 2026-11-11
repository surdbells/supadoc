import {
  aboveRangeAlert,
  aboveRangeStaleAlert,
  aboveRangeSummary,
  aboveRangeWarning,
  belowMinError,
  bmiAboveRangeWarning,
  bpCeilingError,
  ceilingError,
} from './vitals-range-copy';

describe('vitals range copy (patient)', () => {
  it('asks to check the reading, then to seek urgent care', () => {
    expect(aboveRangeWarning(45, '°C')).toBe(
      'This is higher than readings usually go (up to 45 °C). Please check it was measured and entered correctly. If it is right, seek urgent medical attention.',
    );
    expect(aboveRangeWarning('260/160', 'mmHg')).toContain(
      '(up to 260/160 mmHg)',
    );
    expect(bmiAboveRangeWarning(90)).toContain(
      'Please check your weight and height were entered correctly.',
    );
  });

  it('counts readings for the Save reminder', () => {
    expect(aboveRangeSummary(0)).toBe('');
    expect(aboveRangeSummary(1)).toBe(
      '1 reading is higher than readings usually go. Please check it before you save.',
    );
    expect(aboveRangeSummary(3)).toBe(
      '3 readings are higher than readings usually go. Please check them before you save.',
    );
  });

  it('says it on Medical Information, in the past tense when out of date', () => {
    expect(aboveRangeAlert('Temperature', '45', '°C')).toBe(
      'Temperature is higher than readings usually go (up to 45 °C). Please check it was measured and entered correctly.',
    );
    expect(aboveRangeAlert('Weight', null, 'kg')).toBe(
      'Weight is higher than readings usually go. Please check it was measured and entered correctly.',
    );
    expect(aboveRangeStaleAlert('Temperature', '12 Sep')).toBe(
      'Temperature was higher than readings usually go on 12 Sep',
    );
  });

  it('mirrors the API errors', () => {
    expect(ceilingError('Temperature', 9999, '°C')).toBe(
      "Temperature can't be more than 9999 °C. Check the reading.",
    );
    expect(bpCeilingError(999)).toBe(
      "Blood pressure numbers can't be more than 999. Check the reading.",
    );
    expect(belowMinError('Temperature', 30, '°C')).toBe(
      'Temperature must be at least 30 °C',
    );
  });

  it('never says "abnormal"', () => {
    const all = [
      aboveRangeWarning(45, '°C'),
      bmiAboveRangeWarning(90),
      aboveRangeSummary(2),
      aboveRangeAlert('Temperature', '45', '°C'),
      aboveRangeStaleAlert('Temperature', '1 Jan'),
    ].join(' ');
    expect(all.toLowerCase()).not.toContain('abnormal');
  });
});
