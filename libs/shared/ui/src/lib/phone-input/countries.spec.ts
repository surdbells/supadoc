// The parity fixture lives outside every Nx project (the API tests read it too).
// eslint-disable-next-line @nx/enforce-module-boundaries
import fixture from '../../../../../../fixtures/doctor-applications/world-countries.json';
import { WORLD_COUNTRIES } from './countries';

interface FixtureCountry {
  iso: string;
  name: string;
  dial: string;
  primary?: boolean;
}

describe('WORLD_COUNTRIES', () => {
  it('equals the shared fixture (the API checks Countries::ALL against it too)', () => {
    const expected = (fixture as FixtureCountry[]).map((c) => ({
      iso: c.iso,
      name: c.name,
      dialCode: c.dial,
      ...(c.primary ? { primary: true } : {}),
    }));
    expect(WORLD_COUNTRIES.map((c) => ({ ...c }))).toEqual(expected);
  });

  it('puts Nigeria first', () => {
    expect(WORLD_COUNTRIES[0].iso).toBe('NG');
  });

  it('has no entry without a dial code, and no duplicate codes', () => {
    for (const c of WORLD_COUNTRIES) expect(c.dialCode).toMatch(/^\+\d{1,4}$/);
    expect(new Set(WORLD_COUNTRIES.map((c) => c.iso)).size).toBe(WORLD_COUNTRIES.length);
  });

  it('marks exactly one primary country for every shared calling code', () => {
    const byCode = new Map<string, typeof WORLD_COUNTRIES[number][]>();
    for (const c of WORLD_COUNTRIES) byCode.set(c.dialCode, [...(byCode.get(c.dialCode) ?? []), c]);
    for (const [code, list] of byCode) {
      const primaries = list.filter((c) => c.primary).length;
      if (list.length > 1) expect(primaries, code).toBe(1);
      else expect(primaries, code).toBe(0);
    }
    const primaryOf = (code: string) => byCode.get(code)?.find((c) => c.primary)?.iso;
    expect(primaryOf('+44')).toBe('GB');
    expect(primaryOf('+1')).toBe('US');
    expect(primaryOf('+7')).toBe('RU');
  });
});
