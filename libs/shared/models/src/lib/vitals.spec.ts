import { storedReadingValue } from './vitals';

describe('storedReadingValue', () => {
  it('rounds to one decimal place, half up, as the API stores readings', () => {
    expect(storedReadingValue(45.04)).toBe(45);
    expect(storedReadingValue(45.05)).toBe(45.1);
    expect(storedReadingValue(41.25)).toBe(41.3);
    expect(storedReadingValue(250)).toBe(250);
    expect(storedReadingValue(37.96)).toBe(38);
  });
});
