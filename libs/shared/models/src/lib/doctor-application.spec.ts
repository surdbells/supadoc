// The parity fixture lives outside every Nx project (the API tests read it too).
// eslint-disable-next-line @nx/enforce-module-boundaries
import languages from '../../../../../fixtures/doctor-applications/application-languages.json';
import {
  APPLICATION_LANGUAGES,
  APPLICATION_MAX_UPLOAD_BYTES,
  APPLICATION_REFERENCE_PATTERN,
  APPLICATION_STEPS,
  DRAFT_CODE_PATTERN,
  WITHDRAW_REASON_LABELS,
} from './doctor-application';

describe('doctor application contract', () => {
  it('offers exactly the shared language list (the API checks the same fixture)', () => {
    expect([...APPLICATION_LANGUAGES]).toEqual(languages);
  });

  it('lists the seven wizard steps in order', () => {
    expect(APPLICATION_STEPS).toEqual([
      'personal',
      'professional',
      'licence',
      'qualifications',
      'documents',
      'indemnity',
      'consent',
    ]);
  });

  it('caps uploads at 5 MB', () => {
    expect(APPLICATION_MAX_UPLOAD_BYTES).toBe(5242880);
  });

  it('matches reference numbers as GVM-DR-YYYY-NNNNN only', () => {
    expect(APPLICATION_REFERENCE_PATTERN.test('GVM-DR-2026-48213')).toBe(true);
    expect(APPLICATION_REFERENCE_PATTERN.test('gvm-dr-2026-48213')).toBe(false);
    expect(APPLICATION_REFERENCE_PATTERN.test('GVM-DR-2026-4821')).toBe(false);
    expect(APPLICATION_REFERENCE_PATTERN.test(' GVM-DR-2026-48213')).toBe(false);
  });

  it('matches 6-character Crockford base32 draft codes (no I, L, O or U)', () => {
    expect(DRAFT_CODE_PATTERN.test('7K3M9Q')).toBe(true);
    expect(DRAFT_CODE_PATTERN.test('0123AB')).toBe(true);
    for (const bad of ['7K3M9', '7K3M9QX', '7k3m9q', '7K3M9I', '7K3M9L', '7K3M9O', '7K3M9U', '7K3-9Q']) {
      expect(DRAFT_CODE_PATTERN.test(bad)).toBe(false);
    }
  });

  it('labels every withdraw reason', () => {
    expect(Object.keys(WITHDRAW_REASON_LABELS)).toEqual([
      'accepted_other_role',
      'apply_later',
      'made_mistake',
      'not_right_for_me',
      'other',
    ]);
    expect(Object.values(WITHDRAW_REASON_LABELS).every((l) => l.length > 0)).toBe(true);
  });
});
