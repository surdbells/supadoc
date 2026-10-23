import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DoctorApi } from '@supadoc/data-access';
import type { DoctorOnboardingDto, SpecialistCredentialDto } from '@supadoc/models';
import { type ConfirmOptions, DialogService, provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { DoctorStandingStore } from '../standing/doctor-standing.store';
import { licenceWording } from '../standing/standing-rules';
import { DoctorOnboarding, itemsFor } from './onboarding';

function credential(over: Partial<SpecialistCredentialDto> = {}): SpecialistCredentialDto {
  return {
    id: 'c-1',
    type: 'good_standing_certificate',
    type_label: 'Certificate of Good Standing',
    number: 'GMC-7001',
    issued_at: '2026-06-01',
    expires_at: null,
    status: 'verified',
    status_label: 'Verified',
    rejection_reason: null,
    original_name: 'cgs.pdf',
    mime: 'application/pdf',
    size_bytes: 1000,
    reviewed_at: '2026-10-20T10:00:00Z',
    created_at: '2026-10-20T10:00:00Z',
    ...over,
  };
}

function onboarding(over: Partial<DoctorOnboardingDto> = {}): DoctorOnboardingDto {
  return {
    status: 'invited',
    status_label: 'Invited',
    rejection_reason: null,
    submitted_at: null,
    approved_at: null,
    checklist: {
      photo: false,
      bio: true,
      qualifications: true,
      mdcn: true,
      mdcn_certificate: true,
      practising_licence: true,
      signature: false,
      availability: false,
      payout: false,
      terms: false,
    },
    completed: 5,
    total: 10,
    complete: false,
    credentials: [],
    locked_fields: ['name', 'specialty', 'mdcn_number', 'qualifications', 'qualification_entries', 'certifications'],
    pending_changes: null,
    pending_changes_submitted_at: null,
    changes_review_note: null,
    terms: { current_version: '1.0', accepted_version: null, accepted_at: null, accepted: false },
    licence: { expires_at: '2027-06-01', status: 'valid' },
    suspension: null,
    standing: { code: 'doctor_not_approved', message: 'Finish setting up.' },
    ...over,
  };
}

const ABROAD: Partial<DoctorOnboardingDto> = {
  licence_route: 'abroad',
  registration: { regulator_name: 'General Medical Council', regulator_country: 'GB', registration_number: 'GMC-7001' },
  application: { id: 'app-1', reference: 'GVM-DR-2026-48213', approved_at: '2026-10-20T10:00:00Z' },
  go_live_on_submit: true,
  credentials: [
    credential(),
    credential({ id: 'c-2', type: 'foreign_practising_licence', type_label: 'Practising licence (outside Nigeria)', expires_at: '2027-06-01' }),
  ],
};

describe('itemsFor', () => {
  it('keeps the MDCN steps for Nigeria and swaps in the regulator’s abroad', () => {
    const ng = itemsFor(licenceWording(null));
    expect(ng.find((i) => i.key === 'mdcn')?.label).toBe('MDCN registration number');
    expect(ng.find((i) => i.key === 'mdcn_certificate')?.document).toBe('mdcn_full_registration');
    const abroad = itemsFor(licenceWording(onboarding(ABROAD)));
    expect(abroad.map((i) => i.key)).toEqual(ng.map((i) => i.key));
    expect(abroad.find((i) => i.key === 'mdcn')).toMatchObject({ label: 'Licence or registration number', hint: 'Your General Medical Council number.' });
    expect(abroad.find((i) => i.key === 'mdcn_certificate')).toMatchObject({ label: 'Certificate of Good Standing', document: 'good_standing_certificate' });
    expect(abroad.find((i) => i.key === 'practising_licence')).toMatchObject({ label: 'Practising licence', document: 'foreign_practising_licence' });
  });
});

describe('DoctorOnboarding — an approved application', () => {
  let fixture: ComponentFixture<DoctorOnboarding>;
  let el: HTMLElement;
  let asked: ConfirmOptions[];
  let submitted: DoctorOnboardingDto;
  let standingLoads: boolean[];

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const button = (text: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);

  async function setup(data: DoctorOnboardingDto, afterSubmit: DoctorOnboardingDto = data) {
    asked = [];
    standingLoads = [];
    submitted = afterSubmit;
    TestBed.configureTestingModule({
      imports: [DoctorOnboarding],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: DoctorApi, useValue: { onboarding: () => of({ data }), submitOnboarding: () => of({ data: submitted }) } },
        {
          provide: DoctorStandingStore,
          useValue: {
            onboarding: signal(null),
            set: () => undefined,
            load: (force = false) => {
              standingLoads.push(force);
              return Promise.resolve(null);
            },
          },
        },
        {
          provide: DialogService,
          useValue: {
            requests: signal([]),
            confirm: (o: ConfirmOptions) => {
              asked.push(o);
              return Promise.resolve({ confirmed: true });
            },
          },
        },
      ],
    });
    fixture = TestBed.createComponent(DoctorOnboarding);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
  }

  afterEach(() => el?.remove());

  it('welcomes them with their reference and marks what the application filled in', async () => {
    await setup(onboarding(ABROAD));
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Welcome aboard');
    expect(el.textContent).toContain('Your application GVM-DR-2026-48213 was approved. Set up your profile and availability so patients can start booking you.');
    expect(el.textContent).toContain('Licence or registration number');
    expect(el.textContent).toContain('Your General Medical Council number.');
    expect(el.textContent).toContain('Certificate of Good Standing');
    expect(el.textContent).not.toContain('MDCN');
    const tags = Array.from(el.querySelectorAll('li')).filter((li) => li.textContent?.includes('From your application'));
    expect(tags).toHaveLength(5);
    expect(el.textContent).toContain('Ready to go live');
    expect(el.textContent).toContain('Finish every step and you go live straight away — your documents were verified with your application.');
    expect(button('Go live')?.disabled).toBe(true);
    expect(button('Submit for review')).toBeUndefined();
  });

  it('goes live at once when every check passes', async () => {
    await setup(
      onboarding({ ...ABROAD, complete: true, completed: 10 }),
      onboarding({ ...ABROAD, status: 'approved', go_live_on_submit: false, standing: null, approved_at: '2026-10-23T10:00:00Z' }),
    );
    button('Go live')?.click();
    await render();
    expect(asked[0].title).toBe('Go live now?');
    await render();
    expect(el.textContent).toContain("You're live.");
    expect(el.textContent).toContain('Patients can now find and book you.');
    expect(standingLoads).toContain(true);
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Your account');
  });

  it('says it went for a quick final check when go-live falls back to review', async () => {
    await setup(
      onboarding({ ...ABROAD, complete: true, completed: 10 }),
      onboarding({ ...ABROAD, status: 'pending_review', go_live_on_submit: false, submitted_at: '2026-10-23T10:00:00Z' }),
    );
    button('Go live')?.click();
    await render();
    await render();
    expect(el.textContent).toContain('Sent for a quick final check.');
    expect(el.textContent).toContain("We'll email you when you're live");
    expect(el.textContent).not.toContain("You're live.");
  });

  it('keeps the MDCN checklist and "Submit for review" for a doctor without an application', async () => {
    await setup(onboarding({ complete: true }));
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Get set up on VideoMed');
    expect(el.textContent).toContain('MDCN registration number');
    expect(el.textContent).not.toContain('From your application');
    expect(button('Submit for review')).toBeTruthy();
    expect(button('Go live')).toBeUndefined();
  });
});
