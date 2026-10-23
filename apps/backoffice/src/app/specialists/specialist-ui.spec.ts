import type { SpecialistDetailDto } from '@supadoc/models';
import {
  calendarDay,
  CHECKLIST,
  checklistFor,
  clinicTodayYmd,
  codeLabel,
  credentialBadge,
  doctorLicenceWording,
  licenceBadge,
  licenceWording,
  loginBadge,
  money,
  plural,
  registrationNumber,
  statusBadge,
} from './specialist-ui';

describe('specialist-ui', () => {
  it('shows a YYYY-MM-DD day as written, whatever the viewer zone', () => {
    expect(calendarDay('2026-12-31')).toBe('31 Dec 2026');
    expect(calendarDay('2027-01-01')).toBe('1 Jan 2027');
    expect(calendarDay(null)).toBe('—');
    expect(calendarDay('not a date')).toBe('—');
  });

  it('words every state, never colour alone', () => {
    for (const s of ['invited', 'pending_review', 'approved', 'rejected', 'suspended'] as const) {
      const b = statusBadge(s);
      expect(b.label).not.toBe('');
      expect(b.icon).not.toBe('');
    }
    expect(statusBadge(undefined).label).toBe('Approved'); // a legacy doctor
    expect(credentialBadge('superseded').label).toBe('Replaced');
    expect(licenceBadge('expired', '2026-09-30').label).toBe(`Licence expired ${calendarDay('2026-09-30')}`);
    expect(licenceBadge('expiring', '2026-11-02').icon).toBe('hourglass');
    expect(licenceBadge('missing', null).label).toBe('No licence on file');
  });

  it('describes the doctor login', () => {
    expect(loginBadge(null).label).toBe('No login yet');
    expect(loginBadge({ id: 'u', email: 'a@b.c', active: false, password_set: true, invite_pending: false, invite_expires_at: null }).label).toBe('Login deactivated');
    expect(loginBadge({ id: 'u', email: 'a@b.c', active: true, password_set: false, invite_pending: false, invite_expires_at: null }).label).toBe('Invite expired');
  });

  it('labels suspension codes and counts', () => {
    expect(codeLabel('licence_expired')).toBe('Practising licence expired');
    expect(codeLabel('something_new')).toBe('something new');
    expect(plural(1, 'booking')).toBe('1 booking');
    expect(plural(3, 'booking')).toBe('3 bookings');
  });

  it('formats money, and a dash for nothing', () => {
    expect(money('12500.00', 'NGN')).toContain('12,500');
    expect(money('', 'NGN')).toBe('—');
    expect(money(null)).toBe('—');
  });

  it("dates licence expiry checks on the clinic's calendar (Lagos), not the viewer's", () => {
    // 23:30 UTC is already the next day in Lagos (UTC+1) — the day the API uses.
    expect(clinicTodayYmd(new Date('2026-10-14T23:30:00Z'))).toBe('2026-10-15');
    expect(clinicTodayYmd(new Date('2026-10-14T22:59:00Z'))).toBe('2026-10-14');
  });

  it('words licensing by route: MDCN in Nigeria, the regulator abroad', () => {
    const ng = licenceWording('ng');
    expect(ng).toMatchObject({
      abroad: false,
      numberLabel: 'MDCN number',
      registerName: 'the MDCN register',
      registrationType: 'mdcn_full_registration',
      licenceType: 'annual_practising_licence',
    });
    expect(licenceWording(undefined).abroad).toBe(false);
    const gmc = licenceWording('abroad', 'General Medical Council');
    expect(gmc).toMatchObject({
      abroad: true,
      regulator: 'General Medical Council',
      numberLabel: 'General Medical Council number',
      registerName: 'the General Medical Council register',
      registrationDoc: 'Certificate of Good Standing',
      registrationType: 'good_standing_certificate',
      licenceDoc: 'Practising licence',
      licenceType: 'foreign_practising_licence',
    });
    expect(licenceWording('abroad', '  ').numberLabel).toBe('Registration number');
    expect(checklistFor(ng)).toBe(CHECKLIST);
    const abroad = checklistFor(gmc);
    expect(abroad.find((c) => c.key === 'mdcn')?.label).toBe('Licence or registration number');
    expect(abroad.find((c) => c.key === 'mdcn_certificate')?.label).toBe('Certificate of Good Standing');
    expect(abroad.find((c) => c.key === 'practising_licence')?.label).toBe('Practising licence');
    expect(abroad).toHaveLength(CHECKLIST.length);
  });

  it("reads a doctor page's route from the onboarding payload, else the profile", () => {
    const detail = (over: Partial<SpecialistDetailDto>) =>
      ({ profile: { mdcn_number: 'MDCN/1', registration_number: 'GMC-9', regulator_name: 'General Medical Council' }, ...over }) as unknown as SpecialistDetailDto;
    expect(doctorLicenceWording(detail({})).abroad).toBe(false);
    expect(registrationNumber(detail({}))).toBe('MDCN/1');
    const abroad = detail({ licence_route: 'abroad', registration: { regulator_name: 'Medical Council of Ireland', regulator_country: 'IE', registration_number: 'IMC-5' } });
    expect(doctorLicenceWording(abroad).regulator).toBe('Medical Council of Ireland');
    expect(registrationNumber(abroad)).toBe('IMC-5');
  });
});
