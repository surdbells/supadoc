import { isDefined, isEmpty, isNil } from './predicates';

describe('predicates', () => {
  it('isDefined narrows out null/undefined but keeps falsy values', () => {
    expect(isDefined(0)).toBe(true);
    expect(isDefined('')).toBe(true);
    expect(isDefined(null)).toBe(false);
    expect(isDefined(undefined)).toBe(false);
  });

  it('isNil detects only null/undefined', () => {
    expect(isNil(null)).toBe(true);
    expect(isNil(undefined)).toBe(true);
    expect(isNil('')).toBe(false);
    expect(isNil(0)).toBe(false);
  });

  it('isEmpty covers common empty values', () => {
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty('   ')).toBe(true);
    expect(isEmpty([])).toBe(true);
    expect(isEmpty({})).toBe(true);
    expect(isEmpty('x')).toBe(false);
    expect(isEmpty([1])).toBe(false);
  });
});
