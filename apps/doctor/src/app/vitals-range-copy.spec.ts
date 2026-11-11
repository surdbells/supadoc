import {
  chartAboveRange,
  RX_PAGE_ABOVE_RANGE,
  rxAboveRange,
  rxAboveRangeSend,
  rxAboveRangeSummary,
} from './vitals-range-copy';

describe('vitals range copy (doctor)', () => {
  it('asks to confirm the reading before issuing', () => {
    expect(rxAboveRange('temperature', 45, '°C')).toBe(
      'Above the expected range (max 45 °C). Confirm the reading before issuing.',
    );
    expect(rxAboveRange('blood_pressure', '260/160', 'mmHg')).toBe(
      'Above the expected range (max 260/160 mmHg). Confirm the reading before issuing.',
    );
    expect(rxAboveRange('bmi', 90, 'kg/m²')).toBe(
      'Above the expected range (max 90 kg/m²). Confirm weight and height before issuing.',
    );
  });

  it('counts and lists them', () => {
    expect(rxAboveRangeSummary(0)).toBe('');
    expect(rxAboveRangeSummary(1)).toBe(
      '1 reading above the expected range — confirm before issuing.',
    );
    expect(rxAboveRangeSummary(2)).toBe(
      '2 readings above the expected range — confirm before issuing.',
    );
    expect(rxAboveRangeSend([])).toBe('');
    expect(
      rxAboveRangeSend(['Temperature 46 °C', 'Heart rate 260 beats/min']),
    ).toBe(
      'Above the expected range: Temperature 46 °C, Heart rate 260 beats/min. Confirm the readings before issuing.',
    );
  });

  it('marks saved readings', () => {
    expect(chartAboveRange('45', '°C')).toBe(
      'Above the expected range (max 45 °C) — confirm the reading.',
    );
    expect(chartAboveRange(null, '°C')).toBe(
      'Above the expected range — confirm the reading.',
    );
    expect(RX_PAGE_ABOVE_RANGE).toBe('Above expected range — verify');
  });
});
