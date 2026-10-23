import type { DoctorOnboardingDto, SpecialistCredentialDto } from '@supadoc/models';
import { proposableTimes } from '../appointment/follow-up-planner';
import { termsParts } from '../onboarding/terms';
import {
  changedFieldsLabel,
  daysUntil,
  inDaysLabel,
  isBlockingStanding,
  latestCredential,
  licenceDocuments,
  licenceWording,
  pageAllowed,
  renewalText,
  sectionOf,
  standingNotices,
} from './standing-rules';

const TODAY = '2026-10-15';

function credential(over: Partial<SpecialistCredentialDto> = {}): SpecialistCredentialDto {
  return {
    id: 'c-1',
    type: 'annual_practising_licence',
    type_label: 'Annual practising licence',
    number: 'APL-1',
    issued_at: '2026-01-01',
    expires_at: '2026-12-31',
    status: 'verified',
    status_label: 'Verified',
    rejection_reason: null,
    original_name: 'apl.pdf',
    mime: 'application/pdf',
    size_bytes: 1000,
    reviewed_at: null,
    created_at: '2026-01-02T10:00:00Z',
    ...over,
  };
}

function onboarding(over: Partial<DoctorOnboardingDto> = {}): DoctorOnboardingDto {
  return {
    status: 'approved',
    status_label: 'Approved',
    rejection_reason: null,
    submitted_at: null,
    approved_at: '2026-01-05T10:00:00Z',
    checklist: {
      photo: true,
      bio: true,
      qualifications: true,
      mdcn: true,
      mdcn_certificate: true,
      practising_licence: true,
      signature: true,
      availability: true,
      payout: true,
      terms: true,
    },
    completed: 10,
    total: 10,
    complete: true,
    credentials: [],
    locked_fields: ['name', 'specialty', 'mdcn_number', 'qualifications', 'qualification_entries', 'certifications'],
    pending_changes: null,
    pending_changes_submitted_at: null,
    changes_review_note: null,
    terms: { current_version: '1.0', accepted_version: '1.0', accepted_at: '2026-01-04T10:00:00Z', accepted: true },
    licence: { expires_at: '2026-12-31', status: 'valid' },
    suspension: null,
    standing: null,
    ...over,
  };
}

describe('pageAllowed', () => {
  it('opens every page in good standing, and while only the terms are owed', () => {
    expect(pageAllowed(null, '/schedule')).toBe(true);
    expect(pageAllowed('terms_required', '/patients/12')).toBe(true);
  });

  it('keeps a suspended doctor to their account, setup and money pages', () => {
    for (const url of ['/dashboard', '/onboarding/credentials', '/profile', '/earnings', '/payouts?x=1', '/account-status?page=schedule', '/settings']) {
      expect(pageAllowed('doctor_suspended', url)).toBe(true);
    }
    for (const url of ['/schedule', '/appointments/history', '/appointments/a-1', '/patients', '/prescriptions/new', '/availability', '/reviews']) {
      expect(pageAllowed('doctor_suspended', url)).toBe(false);
    }
  });

  it('lets a doctor still onboarding set their availability, but no clinical page', () => {
    expect(pageAllowed('doctor_not_approved', '/availability')).toBe(true);
    expect(pageAllowed('doctor_not_approved', '/schedule')).toBe(false);
    expect(pageAllowed('doctor_not_approved', '/prescriptions')).toBe(false);
  });

  it('does not mistake a longer path for an allowed one', () => {
    expect(pageAllowed('doctor_suspended', '/profiles-of-patients')).toBe(false);
  });

  it('names the section of a URL and the blocking codes', () => {
    expect(sectionOf('/appointments/12?tab=notes')).toBe('appointments');
    expect(isBlockingStanding('terms_required')).toBe(false);
    expect(isBlockingStanding('doctor_not_approved')).toBe(true);
  });
});

describe('dates', () => {
  it('counts whole days across months and years', () => {
    expect(daysUntil('2026-10-16', TODAY)).toBe(1);
    expect(daysUntil('2026-11-14', TODAY)).toBe(30);
    expect(daysUntil('2027-01-01', '2026-12-31')).toBe(1);
    expect(daysUntil('2026-10-14', TODAY)).toBe(-1);
  });

  it('says how soon', () => {
    expect(inDaysLabel(0)).toBe('today');
    expect(inDaysLabel(1)).toBe('tomorrow');
    expect(inDaysLabel(14)).toBe('in 14 days');
  });
});

describe('latestCredential', () => {
  it('takes the newest of a type that has not been replaced', () => {
    const list = [
      credential({ id: 'new', status: 'pending' }),
      credential({ id: 'old', status: 'verified' }),
      credential({ id: 'cert', type: 'mdcn_full_registration' }),
    ];
    expect(latestCredential(list, 'annual_practising_licence')?.id).toBe('new');
    expect(latestCredential(list, 'mdcn_full_registration')?.id).toBe('cert');
    expect(latestCredential([credential({ status: 'superseded' })], 'annual_practising_licence')).toBeNull();
  });
});

describe('licenceDocuments', () => {
  const inForce = { expires_at: '2026-12-31', status: 'valid' } as const;

  it('keeps the verified licence in force beside a newer upload, as its renewal', () => {
    const rejected = credential({ id: 'new', status: 'rejected', rejection_reason: 'Blurry', expires_at: '2027-12-31' });
    const pending = credential({ id: 'new', status: 'pending', expires_at: '2027-12-31' });
    const verified = credential({ id: 'old' });
    expect(licenceDocuments([rejected, verified], inForce)).toEqual({ current: verified, renewal: rejected });
    expect(licenceDocuments([pending, verified], { ...inForce, status: 'expiring' })).toEqual({ current: verified, renewal: pending });
    expect(renewalText(rejected)).toBe('Renewal not accepted: Blurry');
    expect(renewalText(pending)).toBe('Renewal (to 31 Dec 2027) waiting for verification.');
  });

  it('shows the newest upload alone when no licence is in force, or it is the verified one', () => {
    const pending = credential({ id: 'new', status: 'pending' });
    const verified = credential({ id: 'old' });
    expect(licenceDocuments([pending, verified], { expires_at: '2026-10-01', status: 'expired' })).toEqual({ current: pending, renewal: null });
    expect(licenceDocuments([pending], { expires_at: null, status: 'missing' })).toEqual({ current: pending, renewal: null });
    expect(licenceDocuments([verified], inForce)).toEqual({ current: verified, renewal: null });
    expect(licenceDocuments([], inForce)).toEqual({ current: null, renewal: null });
  });

  it('calls a refused renewal a renewal on the dashboard', () => {
    const notices = standingNotices(
      onboarding({ credentials: [credential({ id: 'new', status: 'rejected' }), credential({ id: 'old' })] }),
      TODAY,
    );
    expect(notices.map((n) => n.title)).toEqual(["Your licence renewal wasn't accepted"]);
  });
});

describe('standingNotices', () => {
  it('says nothing for an approved doctor in good order', () => {
    expect(standingNotices(onboarding(), TODAY)).toEqual([]);
  });

  it('shows only the suspension, with its reason', () => {
    const notices = standingNotices(
      onboarding({
        status: 'suspended',
        terms: { current_version: '2.0', accepted_version: '1.0', accepted_at: null, accepted: false },
        suspension: { code: 'licence_expired', code_label: 'Practising licence expired', reason: 'Renew it', suspended_at: null },
      }),
      TODAY,
    );
    expect(notices.map((n) => n.key)).toEqual(['suspended']);
    expect(notices[0].text).toContain('Practising licence expired: Renew it');
  });

  it('keeps the onboarding stage until approval', () => {
    expect(standingNotices(onboarding({ status: 'invited', completed: 4 }), TODAY)[0].text).toContain('4 of 10');
    expect(standingNotices(onboarding({ status: 'pending_review' }), TODAY)[0].key).toBe('review');
  });

  it('asks for the updated terms, and counts down to the licence expiry', () => {
    const keys = standingNotices(
      onboarding({
        terms: { current_version: '2.0', accepted_version: '1.0', accepted_at: null, accepted: false },
        licence: { expires_at: '2026-10-29', status: 'expiring' },
      }),
      TODAY,
    );
    expect(keys.map((n) => n.key)).toEqual(['terms', 'licence-expiring']);
    expect(keys[1].title).toBe('Your practising licence expires in 14 days');
    expect(keys[1].tone).toBe('warning');
  });

  it('notes a renewal already waiting for verification', () => {
    const [n] = standingNotices(
      onboarding({
        licence: { expires_at: '2026-10-29', status: 'expiring' },
        credentials: [credential({ status: 'pending', expires_at: '2027-10-28' })],
      }),
      TODAY,
    );
    expect(n.tone).toBe('info');
    expect(n.text).toContain('waiting for verification');
  });

  it('asks a legacy doctor for their documents, and shows refused ones and a waiting change', () => {
    const notices = standingNotices(
      onboarding({
        credentials_due_at: '2026-11-14',
        checklist: { ...onboarding().checklist, mdcn_certificate: false },
        credentials: [credential({ type: 'mdcn_full_registration', type_label: 'MDCN full-registration certificate', status: 'rejected', rejection_reason: 'Blurry' })],
        pending_changes: { name: 'Dr New', mdcn_number: 'MDCN/1' },
      }),
      TODAY,
    );
    expect(notices.map((n) => n.key)).toEqual(['credentials-missing', 'rejected-mdcn_full_registration', 'changes-pending']);
    expect(notices[0].text).toContain('14 Nov 2026');
    expect(notices[1].text).toBe("Reviewer's note: Blurry");
    expect(notices[2].text).toContain('Name and MDCN number');
  });
});

describe('changedFieldsLabel', () => {
  it('lists each field once', () => {
    expect(changedFieldsLabel(['qualifications', 'qualification_entries'])).toBe('Qualifications');
    expect(changedFieldsLabel(['name', 'specialty', 'certifications'])).toBe('Name, Speciality and Certifications');
  });

  it("names the registration number the doctor's way", () => {
    expect(changedFieldsLabel(['name', 'mdcn_number'])).toBe('Name and MDCN number');
    expect(changedFieldsLabel(['mdcn_number'], 'General Medical Council number')).toBe('General Medical Council number');
  });
});

describe('licenceWording — MDCN in Nigeria, the regulator abroad', () => {
  const abroad = {
    licence_route: 'abroad' as const,
    registration: { regulator_name: 'General Medical Council', regulator_country: 'GB', registration_number: 'GMC-7001' },
  };

  it('reads an older payload (no route) as Nigeria', () => {
    expect(licenceWording(null)).toMatchObject({ abroad: false, numberLabel: 'MDCN number', registerName: 'the MDCN register', licenceType: 'annual_practising_licence' });
    expect(licenceWording({ licence_route: 'ng', registration: null }).registrationType).toBe('mdcn_full_registration');
  });

  it('names the regulator, its register and the abroad documents', () => {
    expect(licenceWording(abroad)).toEqual({
      abroad: true,
      regulator: 'General Medical Council',
      numberLabel: 'General Medical Council number',
      registerName: 'the General Medical Council register',
      registrationDoc: 'Certificate of Good Standing',
      registrationType: 'good_standing_certificate',
      licenceDoc: 'Practising licence',
      licenceType: 'foreign_practising_licence',
    });
    expect(licenceWording({ licence_route: 'abroad', registration: null }).numberLabel).toBe('Registration number');
  });

  it('keeps the foreign licence in force beside its renewal', () => {
    const verified = credential({ id: 'old', type: 'foreign_practising_licence' });
    const pending = credential({ id: 'new', type: 'foreign_practising_licence', status: 'pending', expires_at: '2027-12-31' });
    const inForce = { expires_at: '2026-12-31', status: 'valid' } as const;
    expect(licenceDocuments([pending, verified], inForce, 'foreign_practising_licence')).toEqual({ current: verified, renewal: pending });
    expect(licenceDocuments([pending, verified], inForce)).toEqual({ current: null, renewal: null });
  });

  it('words the onboarding notices for a doctor from an application', () => {
    const [setup] = standingNotices(onboarding({ status: 'invited', completed: 7, application: { id: 'a1', reference: 'GVM-DR-2026-48213', approved_at: '2026-10-20T10:00:00Z' } }), TODAY);
    expect(setup.title).toBe('Finish setting up your profile to go live');
    expect(setup.text).toContain('7 of 10 steps done');
    const [review] = standingNotices(onboarding({ status: 'pending_review', application: { id: 'a1', reference: 'GVM-DR-2026-48213', approved_at: null } }), TODAY);
    expect(review.title).toBe('Your profile is having a quick final check');
    expect(review.text).toContain("We'll email you when you're live.");
  });

  it('points an abroad doctor at their own documents and register', () => {
    const notices = standingNotices(
      onboarding({
        ...abroad,
        credentials_due_at: '2026-11-14',
        credentials: [
          credential({ id: 'gcs', type: 'good_standing_certificate', type_label: 'Certificate of Good Standing', status: 'rejected', rejection_reason: 'Older than 6 months' }),
        ],
        pending_changes: { mdcn_number: 'X' },
      }),
      TODAY,
    );
    expect(notices.map((n) => n.key)).toEqual(['credentials-missing', 'rejected-good_standing_certificate', 'changes-pending']);
    expect(notices[0].text).toBe('A reviewer is checking your Certificate of Good Standing and practising licence against the General Medical Council register.');
    expect(notices[1].title).toBe("Your certificate of good standing wasn't accepted");
    expect(notices[2].text).toContain('General Medical Council number:');
  });
});

describe('termsParts', () => {
  it('drops the title and gathers list items into lists', () => {
    const parts = termsParts([
      { type: 'h1', text: 'Terms' },
      { type: 'p', text: 'Intro' },
      { type: 'h2', text: '1. Licensure' },
      { type: 'ol', text: 'One' },
      { type: 'ol', text: 'Two' },
      { type: 'ul', text: 'Bullet' },
    ]);
    expect(parts.map((p) => p.kind)).toEqual(['p', 'h2', 'ol', 'ul']);
    expect(parts[2].items).toEqual(['One', 'Two']);
  });
});

describe('proposableTimes', () => {
  it('keeps only times at least 2½ hours ahead (null stays null)', () => {
    const now = Date.UTC(2026, 9, 15, 9, 0);
    const slot = (h: number) => ({ iso: new Date(Date.UTC(2026, 9, 15, h, 0)).toISOString(), time: '', label: '', period: 'morning' as const });
    expect(proposableTimes(null, now)).toBeNull();
    expect(proposableTimes([slot(10), slot(11), slot(12)], now)?.map((s) => s.iso)).toEqual([slot(12).iso]);
  });
});
