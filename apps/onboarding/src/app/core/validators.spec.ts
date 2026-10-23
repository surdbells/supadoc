// The parity fixture lives outside every Nx project (the API's ApplicationSectionsTest runs it too).
// eslint-disable-next-line @nx/enforce-module-boundaries
import cases from '../../../../../fixtures/doctor-applications/validation-cases.json';
import type { ApplicationSectionKey, LicenceRoute } from '@supadoc/models';
import { foldName, goodStandingMessage, isValidEmail, MESSAGES, toE164, validateSection } from './validators';

interface Case {
  title: string;
  section: ApplicationSectionKey;
  route: LicenceRoute;
  today: string;
  partial: boolean;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  context?: {
    specialties?: string[];
    personal?: { first_name: string; last_name: string };
  };
}

const sorted = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

describe('validateSection — shared fixture (server = client)', () => {
  const all = cases as unknown as Case[];

  it('has the fixture', () => {
    expect(all.length).toBeGreaterThan(150);
  });

  it('has a case for every message (as ApplicationSectionsTest)', () => {
    const seen = new Set(all.flatMap((c) => Object.values(c.errors)));
    for (const [key, message] of Object.entries(MESSAGES)) expect(seen.has(message), key).toBe(true);
  });

  for (const c of all) {
    it(c.title, () => {
      const got = validateSection(c.section, c.values, c.route, c.today, c.partial, {
        specialties: c.context?.specialties ?? null,
        personal: c.context?.personal ?? null,
      });
      expect(sorted(got)).toEqual(sorted(c.errors));
    });
  }
});

describe('validator helpers', () => {
  it('normalises phones like PhoneNumber::toE164', () => {
    expect(toE164('0803 123 4567')).toBe('+2348031234567');
    expect(toE164('+234 0803 123 4567')).toBe('+2348031234567');
    expect(toE164('00234 803 123 4567')).toBe('+2348031234567');
    expect(toE164('8031234567')).toBe('+2348031234567');
    expect(toE164('+44 7700 900123')).toBe('+447700900123');
    expect(toE164('0803123456')).toBeNull();
    expect(toE164('+234803123456')).toBeNull();
  });

  it('checks emails like FILTER_VALIDATE_EMAIL', () => {
    expect(isValidEmail('ada+x@example.co.uk')).toBe(true);
    expect(isValidEmail('ada@localhost')).toBe(false);
    expect(isValidEmail('ada..obi@example.com')).toBe(false);
  });

  it('folds accents, case and spaces for the signature', () => {
    expect(foldName('  Ọlátúndé   ADÉBÁYỌ ')).toBe('olatunde adebayo');
    expect(foldName('Zoë')).toBe('zoe');
  });

  it('words the Good Standing window from the clinic date', () => {
    expect(goodStandingMessage('2026-10-23')).toBe(
      'Must be issued on or after 23 April 2026 (within the last 6 months).',
    );
    expect(goodStandingMessage('2026-08-31')).toContain('28 February 2026');
  });
});
