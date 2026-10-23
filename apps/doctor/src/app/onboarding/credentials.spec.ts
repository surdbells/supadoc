import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DoctorApi } from '@supadoc/data-access';
import type { DoctorCredentialsDto, DoctorOnboardingDto, SpecialistCredentialDto } from '@supadoc/models';
import { DialogService, provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { DoctorStandingStore } from '../standing/doctor-standing.store';
import { licenceWording } from '../standing/standing-rules';
import { DoctorCredentials, requiredFor } from './credentials';

function credential(over: Partial<SpecialistCredentialDto> = {}): SpecialistCredentialDto {
  return {
    id: 'c-1',
    type: 'foreign_practising_licence',
    type_label: 'Practising licence (outside Nigeria)',
    number: 'GMC-7001',
    issued_at: null,
    expires_at: '2027-06-01',
    status: 'verified',
    status_label: 'Verified',
    rejection_reason: null,
    original_name: 'licence.pdf',
    mime: 'application/pdf',
    size_bytes: 2048,
    reviewed_at: '2026-10-20T10:00:00Z',
    created_at: '2026-10-20T10:00:00Z',
    ...over,
  };
}

const ABROAD = {
  status: 'invited',
  licence_route: 'abroad',
  registration: { regulator_name: 'General Medical Council', regulator_country: 'GB', registration_number: 'GMC-7001' },
  application: { id: 'app-1', reference: 'GVM-DR-2026-48213', approved_at: '2026-10-20T10:00:00Z' },
  licence: { expires_at: '2027-06-01', status: 'valid' },
} as unknown as DoctorOnboardingDto;

const NG = { status: 'invited', licence: { expires_at: null, status: 'missing' } } as unknown as DoctorOnboardingDto;

describe('requiredFor', () => {
  it('asks for the MDCN documents in Nigeria, the regulator’s abroad', () => {
    expect(requiredFor(licenceWording(NG)).map((r) => r.type)).toEqual(['mdcn_full_registration', 'annual_practising_licence']);
    const abroad = requiredFor(licenceWording(ABROAD));
    expect(abroad.map((r) => r.type)).toEqual(['good_standing_certificate', 'foreign_practising_licence']);
    expect(abroad[0].hint).toBe('Issued by General Medical Council within the last 6 months.');
  });
});

describe('DoctorCredentials', () => {
  let fixture: ComponentFixture<DoctorCredentials>;
  let el: HTMLElement;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function setup(standing: DoctorOnboardingDto, data: DoctorCredentialsDto) {
    TestBed.configureTestingModule({
      imports: [DoctorCredentials],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: DoctorApi, useValue: { credentials: () => of({ data }), credentialFile: () => of(new Blob()) } },
        { provide: DoctorStandingStore, useValue: { onboarding: signal(standing), load: () => Promise.resolve(standing) } },
        { provide: DialogService, useValue: { requests: signal([]), confirm: () => Promise.resolve({ confirmed: false }) } },
      ],
    });
    fixture = TestBed.createComponent(DoctorCredentials);
    el = fixture.nativeElement;
    await render();
  }

  const section = (title: string): HTMLElement | null =>
    Array.from(el.querySelectorAll<HTMLElement>('section')).find((s) => s.querySelector('h2')?.textContent?.trim() === title) ?? null;

  it('keeps the MDCN documents for a doctor licensed in Nigeria', async () => {
    await setup(NG, {
      credentials: [],
      types: [
        { type: 'mdcn_full_registration', label: 'MDCN full-registration certificate', requires_expiry: false, requires_number: false },
        { type: 'annual_practising_licence', label: 'Annual practising licence', requires_expiry: true, requires_number: true },
      ],
      max_bytes: 10_485_760,
      accepted: ['application/pdf'],
    });
    const required = el.querySelector('section[aria-label="Required documents"]')?.textContent ?? '';
    expect(required).toContain('MDCN full-registration certificate');
    expect(required).toContain('Annual practising licence');
    expect(el.textContent).toContain('against the MDCN register');
    expect(section('On file — verified with your application')).toBeNull();
  });

  it('asks an abroad doctor for their regulator’s documents and keeps the application’s on file, read-only', async () => {
    await setup(ABROAD, {
      credentials: [
        credential(),
        credential({ id: 'c-2', type: 'good_standing_certificate', type_label: 'Certificate of Good Standing', number: null, expires_at: null, issued_at: '2026-06-01' }),
        credential({ id: 'c-3', type: 'government_id', type_label: 'Government-issued ID', number: null, expires_at: null, original_name: 'passport.png', mime: 'image/png' }),
        credential({ id: 'c-4', type: 'medical_degree', type_label: 'Medical degree certificate', number: null, expires_at: null, original_name: 'degree.pdf' }),
        credential({ id: 'c-5', type: 'curriculum_vitae', type_label: 'Curriculum vitae', number: null, expires_at: null, status: 'pending', original_name: 'cv.pdf' }),
      ],
      types: [
        { type: 'good_standing_certificate', label: 'Certificate of Good Standing', requires_expiry: false, requires_number: false },
        { type: 'foreign_practising_licence', label: 'Practising licence (outside Nigeria)', requires_expiry: true, requires_number: true },
        { type: 'specialist_certificate', label: 'Specialist certificate', requires_expiry: false, requires_number: false },
        { type: 'indemnity_certificate', label: 'Professional indemnity certificate', requires_expiry: true, requires_number: false },
        // Never offered for upload, even if sent.
        { type: 'government_id', label: 'Government-issued ID', requires_expiry: false, requires_number: false },
      ],
      max_bytes: 10_485_760,
      accepted: ['application/pdf'],
    });
    const required = el.querySelector('section[aria-label="Required documents"]')?.textContent ?? '';
    expect(required).toContain('Certificate of Good Standing');
    expect(required).toContain('Practising licence');
    expect(required).not.toContain('MDCN');
    expect(el.textContent).toContain('against the General Medical Council register');

    const options = Array.from(el.querySelectorAll<HTMLOptionElement>('#cred-type option')).map((o) => o.textContent?.trim());
    expect(options).not.toContain('Government-issued ID');
    expect(options).toContain('Practising licence (outside Nigeria)');

    const mine = section('Your documents');
    expect(mine?.textContent).toContain('Certificate of Good Standing');
    expect(mine?.textContent).not.toContain('Government-issued ID');

    const onFile = section('On file — verified with your application');
    expect(onFile).toBeTruthy();
    expect(onFile?.querySelectorAll('li')).toHaveLength(3);
    expect(onFile?.textContent).toContain('Government-issued ID');
    expect(onFile?.textContent).toContain('Curriculum vitae');
    const buttons = Array.from(onFile?.querySelectorAll('button') ?? []).map((b) => b.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    expect(buttons.every((b) => b.startsWith('View'))).toBe(true);
    expect(buttons.some((b) => b.includes('Delete') || b.includes('Replace'))).toBe(false);
  });

  it('words the indemnity certificate as cover: a policy number and the date the cover expires', async () => {
    await setup(NG, {
      credentials: [],
      types: [
        { type: 'annual_practising_licence', label: 'Annual practising licence', requires_expiry: true, requires_number: true },
        { type: 'indemnity_certificate', label: 'Professional indemnity certificate', requires_expiry: true, requires_number: false },
        { type: 'specialist_certificate', label: 'Specialist certificate', requires_expiry: false, requires_number: false },
      ],
      max_bytes: 10_485_760,
      accepted: ['application/pdf'],
    });
    const pick = async (type: string) => {
      const select = el.querySelector<HTMLSelectElement>('#cred-type');
      if (!select) throw new Error('No #cred-type');
      select.value = type;
      select.dispatchEvent(new Event('change'));
      await render();
    };
    const label = () => el.querySelector('label[for="cred-number"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const submit = async () => {
      el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
      await render();
    };

    await pick('indemnity_certificate');
    expect(label()).toContain('Policy number');
    await submit();
    expect(el.querySelector('#cred-expires-error')?.textContent).toContain('Enter the date your cover expires.');
    expect(el.textContent).not.toContain('Enter the date the licence expires.');

    await pick('annual_practising_licence');
    expect(label()).toContain('Licence number');
    await submit();
    expect(el.querySelector('#cred-expires-error')?.textContent).toContain('Enter the date the licence expires.');

    await pick('specialist_certificate');
    expect(label()).toContain('Certificate number');
  });
});
