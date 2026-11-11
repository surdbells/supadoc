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
    expect(aboveRangeAlert('Weight', null, 'kg', 'weight')).toBe(
      'Weight gives a BMI higher than readings usually go. Please check your weight and height were entered correctly.',
    );
    expect(aboveRangeAlert('Weight', null, 'kg')).toBe(
      'Weight is higher than readings usually go. Please check it was measured and entered correctly.',
    );
    expect(aboveRangeStaleAlert('Temperature', '12 Sep')).toBe(
      'Temperature was higher than readings usually go on 12 Sep',
    );
  });

  it('mirrors the API errors', () => {
    expect(ceilingError('Temperature')).toBe(
      'Temperature is too large to be a reading. Check what you entered.',
    );
    expect(bpCeilingError(999)).toBe(
      'Each blood pressure number must be 3 digits or fewer. Check what you entered.',
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
