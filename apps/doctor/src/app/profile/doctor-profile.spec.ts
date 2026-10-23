import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { DoctorApi, ReferenceApi } from '@supadoc/data-access';
import type {
  DoctorProfileDto,
  DoctorProfileUpdate,
  PublicReferenceItemDto,
} from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { Observable, of, Subject, throwError } from 'rxjs';
import { DoctorStandingStore } from '../standing/doctor-standing.store';
import { DoctorProfile } from './doctor-profile';

const LIST: PublicReferenceItemDto[] = [
  {
    id: 'i1',
    code: 'general-practice',
    label: 'General Practice',
    sort_order: 10,
  },
  { id: 'i2', code: 'cardiology', label: 'Cardiology', sort_order: 20 },
  { id: 'i3', code: 'dermatology', label: 'Dermatology', sort_order: 30 },
];

function profile(over: Partial<DoctorProfileDto> = {}): DoctorProfileDto {
  return {
    id: 'd1',
    name: 'Dr Ada Obi',
    specialty: 'Cardiology',
    location: 'Lagos',
    country: 'Nigeria',
    consultation_fee: '5000.00',
    rating: '4.8',
    reviews_count: 3,
    available: true,
    years_experience: 6,
    languages: 'English',
    verified: false,
    gender: 'female',
    offers_in_person: false,
    photo_url: null,
    email: 'ada@example.test',
    expertise: [],
    qualification_entries: [],
    certifications: [],
    locked_fields: [],
    pending_changes: null,
    ...over,
  } as DoctorProfileDto;
}

describe('DoctorProfile — speciality', () => {
  let fixture: ComponentFixture<DoctorProfile>;
  let el: HTMLElement;
  let current: DoctorProfileDto;
  let listResponses: (() => Observable<{ data: PublicReferenceItemDto[] }>)[];
  let listCalls: number;
  let updates: DoctorProfileUpdate[];
  let updateResult: () => Observable<{ data: DoctorProfileDto }>;

  async function setup(
    p: DoctorProfileDto,
    ...lists: (() => Observable<{ data: PublicReferenceItemDto[] }>)[]
  ) {
    current = p;
    listResponses = lists;
    listCalls = 0;
    updates = [];
    updateResult = () => of({ data: current });
    TestBed.configureTestingModule({
      imports: [DoctorProfile],
      providers: [
        provideSupadocIcons(),
        provideRouter([]),
        {
          provide: DoctorApi,
          useValue: {
            getProfile: () => of({ data: current }),
            getSignature: () =>
              of({ data: { has_signature: false, image: null } }),
            assetUrl: () => null,
            updateProfile: (body: DoctorProfileUpdate) => {
              updates.push(body);
              return updateResult();
            },
          },
        },
        {
          provide: ReferenceApi,
          useValue: {
            publicList: () => {
              const next =
                listResponses[Math.min(listCalls, listResponses.length - 1)];
              listCalls++;
              return next();
            },
          },
        },
        {
          provide: StaffAuthService,
          useValue: { displayName: () => 'Dr Ada Obi' },
        },
        {
          provide: DoctorStandingStore,
          useValue: {
            onboarding: signal(null),
            load: () => Promise.resolve(null),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(DoctorProfile);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
  }

  async function render() {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function button(text: string): HTMLButtonElement {
    const b = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (x) => x.textContent?.trim() === text,
    );
    if (!b) throw new Error(`No button "${text}"`);
    return b;
  }

  async function click(target: HTMLElement) {
    target.click();
    await render();
  }

  const group = () =>
    el.querySelector<HTMLElement>(
      '[role="group"][aria-labelledby="specialty-label"]',
    );
  function trigger(): HTMLButtonElement {
    const b = group()?.querySelector<HTMLButtonElement>(
      'sd-search-select button',
    );
    if (!b) throw new Error('No speciality dropdown');
    return b;
  }
  const optionLabels = () =>
    Array.from(
      group()?.querySelectorAll('sd-search-select li button') ?? [],
    ).map((b) => b.textContent?.trim());

  async function submit() {
    el.querySelector('form')?.dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await render();
  }

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
  });

  it('offers the active specialities as a dropdown while onboarding and saves the one chosen', async () => {
    await setup(profile(), () => of({ data: LIST }));
    await click(button('Edit Profile'));

    expect(
      el.querySelector('sd-input[formcontrolname="specialty"]'),
    ).toBeNull();
    expect(trigger().textContent?.trim()).toBe('Cardiology');
    await click(trigger());
    expect(optionLabels()).toEqual([
      'General Practice',
      'Cardiology',
      'Dermatology',
    ]);

    await click(button('Dermatology'));
    expect(trigger().textContent?.trim()).toBe('Dermatology');
    await submit();
    expect(updates).toHaveLength(1);
    expect(updates[0].specialty).toBe('Dermatology');
  });

  it('shows a speciality the list no longer offers as such, and lets the doctor keep it', async () => {
    await setup(profile({ specialty: 'Tropical Medicine' }), () =>
      of({ data: LIST }),
    );
    expect(el.textContent).toContain(
      'No longer offered in our list of specialities',
    );

    await click(button('Edit Profile'));
    expect(trigger().textContent?.trim()).toBe(
      'Tropical Medicine (no longer offered)',
    );
    expect(el.querySelector('#specialty-hint')?.textContent).toContain(
      'is no longer offered in our list',
    );
    expect(group()?.getAttribute('aria-describedby')).toBe('specialty-hint');

    await submit();
    expect(updates[0].specialty).toBe('Tropical Medicine');
  });

  it('keeps free text while there is no list yet (empty list, or the API from before it)', async () => {
    await setup(
      profile(),
      () => of({ data: [] }),
      () => throwError(() => ({ status: 404 })),
    );
    await click(button('Edit Profile'));
    expect(group()).toBeNull();
    expect(
      el.querySelector('sd-input[formcontrolname="specialty"]'),
    ).not.toBeNull();
    expect(el.textContent).not.toContain(
      "Couldn't load the list of specialities",
    );
    expect(listCalls).toBe(2);
  });

  it('falls back to free text when the list cannot be read, with a way to try again', async () => {
    await setup(
      profile(),
      () => throwError(() => ({ status: 500 })),
      () => throwError(() => ({ status: 500 })),
      () => of({ data: LIST }),
    );
    await click(button('Edit Profile'));
    expect(
      el.querySelector('sd-input[formcontrolname="specialty"]'),
    ).not.toBeNull();
    expect(el.textContent).toContain("Couldn't load the list of specialities");

    // Typed while the list couldn't be read — not one of the list once it loads.
    const typed = el.querySelector<HTMLInputElement>(
      'sd-input[formcontrolname="specialty"] input',
    );
    if (!typed) throw new Error('No speciality text field');
    typed.value = 'Cardio';
    typed.dispatchEvent(new Event('input'));
    await render();

    await click(button('Try again'));
    expect(trigger().textContent?.trim()).toBe('Select your speciality');
    expect(group()?.textContent).toContain(
      'Choose your speciality from the list',
    );
    expect(el.querySelector('#specialty-hint')).toBeNull();

    // Not sent: the API would refuse it. The error is the group's description.
    await submit();
    expect(updates).toHaveLength(0);
    expect(group()?.getAttribute('aria-describedby')).toBe('specialty-error');
    expect(el.querySelector('#specialty-error')?.textContent?.trim()).toBe(
      'Choose your speciality from the list',
    );

    await click(trigger());
    await click(button('Cardiology'));
    expect(trigger().textContent?.trim()).toBe('Cardiology');
    expect(group()?.textContent).not.toContain('Choose your speciality');
    expect(group()?.getAttribute('aria-describedby')).toBeNull();
    await submit();
    expect(updates).toHaveLength(1);
    expect(updates[0].specialty).toBe('Cardiology');
  });

  it('keeps the free-text field while trying the list again, and takes a typed speciality the list has', async () => {
    const retry = new Subject<{ data: PublicReferenceItemDto[] }>();
    await setup(
      profile({ specialty: '' }),
      () => throwError(() => ({ status: 500 })),
      () => throwError(() => ({ status: 500 })),
      () => retry,
    );
    await click(button('Edit Profile'));
    const typed = el.querySelector<HTMLInputElement>(
      'sd-input[formcontrolname="specialty"] input',
    );
    if (!typed) throw new Error('No speciality text field');
    typed.value = 'cardiology ';
    typed.dispatchEvent(new Event('input'));
    await render();

    await click(button('Try again'));
    // Still the text field (not the loading placeholder) while the list is read.
    expect(
      el.querySelector('sd-input[formcontrolname="specialty"]'),
    ).not.toBeNull();
    expect(el.textContent).not.toContain('Loading the list of specialities');
    expect(button('Trying again…').getAttribute('aria-disabled')).toBe('true');

    retry.next({ data: LIST });
    retry.complete();
    await render();
    expect(trigger().textContent?.trim()).toBe('Cardiology');
    expect(group()?.textContent).not.toContain('Choose your speciality');
    await submit();
    expect(updates[0].specialty).toBe('Cardiology');
  });

  it('sends a chosen speciality for review once approved', async () => {
    await setup(
      profile({
        verified: true,
        locked_fields: ['name', 'specialty', 'mdcn_number'],
      }),
      () => of({ data: LIST }),
    );
    await click(button('Edit Profile'));
    // Verified: shown locked in the edit form, no dropdown.
    expect(group()).toBeNull();
    await click(button('Back'));

    await click(button('Request a change'));
    await click(trigger());
    await click(button('General Practice'));
    await submit();
    expect(updates).toHaveLength(1);
    expect(updates[0].specialty).toBe('General Practice');
    expect(updates[0].email).toBeUndefined();
  });

  it('shows the API’s refusal on the field, drops that speciality and reads the list again', async () => {
    await setup(profile(), () => of({ data: LIST }));
    await click(button('Edit Profile'));
    const before = listCalls;
    updateResult = () =>
      throwError(() => ({
        statusCode: 422,
        message: 'Validation failed',
        errors: { specialty: 'Choose a specialty from the list' },
      }));
    await click(trigger());
    await click(button('Dermatology'));
    await submit();
    expect(updates).toHaveLength(1);
    // One wording, on the field and in the banner.
    expect(group()?.textContent).toContain('Choose your speciality from the list');
    expect(el.querySelector('form [role="alert"]')?.textContent?.trim()).toBe(
      'Choose your speciality from the list',
    );
    expect(el.textContent).not.toContain('Choose a specialty');
    expect(listCalls).toBe(before + 1);

    // The list read again is still the (cached) one offering it: not offered, not sent again.
    expect(trigger().textContent?.trim()).toBe('Select your speciality');
    await click(trigger());
    expect(optionLabels()).toEqual(['General Practice', 'Cardiology']);
    await click(trigger());
    await submit();
    expect(updates).toHaveLength(1);

    // Back to their own speciality (nothing left to discard); opening the form again offers the list afresh.
    await click(trigger());
    await click(button('Cardiology'));
    await click(button('Back'));
    await click(button('Edit Profile'));
    await click(trigger());
    expect(optionLabels()).toEqual([
      'General Practice',
      'Cardiology',
      'Dermatology',
    ]);
  });

  it('keeps the doctor’s own speciality in the dropdown when the API refuses a save', async () => {
    await setup(profile(), () => of({ data: LIST }));
    await click(button('Edit Profile'));
    updateResult = () =>
      throwError(() => ({
        statusCode: 422,
        message: 'Validation failed',
        errors: { specialty: 'Choose a specialty from the list' },
      }));
    await submit();
    expect(updates[0].specialty).toBe('Cardiology');
    await click(trigger());
    expect(optionLabels()).toContain('Cardiology');
  });

  it('does not submit the form when Enter is pressed in the gender dropdown’s search box', async () => {
    await setup(profile(), () => of({ data: LIST }));
    await click(button('Edit Profile'));
    const gender = el.querySelector<HTMLElement>(
      '[role="group"][aria-labelledby="gender-label"]',
    );
    gender?.querySelector<HTMLButtonElement>('sd-search-select button')?.click();
    await render();
    const search = gender?.querySelector<HTMLInputElement>(
      'sd-search-select input',
    );
    if (!search) throw new Error('No gender search box');
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    search.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
  });

  it('does not submit the form when Enter is pressed in the dropdown’s search box', async () => {
    await setup(profile(), () => of({ data: LIST }));
    await click(button('Edit Profile'));
    await click(trigger());
    const search = group()?.querySelector<HTMLInputElement>(
      'sd-search-select input',
    );
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    search?.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
  });

  it('shows a doctor licensed abroad their regulator’s registration, read-only, and no MDCN number', async () => {
    await setup(
      profile({
        licence_route: 'abroad',
        regulator_name: 'General Medical Council',
        regulator_country: 'GB',
        registration_number: 'GMC-7001',
        locked_fields: ['name', 'specialty', 'mdcn_number', 'qualifications', 'qualification_entries', 'certifications'],
      }),
      () => of({ data: LIST }),
    );
    const block = el.querySelector('[aria-labelledby="licensing-heading"]');
    expect(block?.textContent).toContain('General Medical Council');
    expect(block?.textContent).toContain('United Kingdom');
    expect(block?.textContent).toContain('GMC-7001');
    expect(block?.textContent).toContain('Verified with your application. Contact support to change it.');
    expect(el.textContent).not.toContain('MDCN registration number');
    expect(el.textContent).toContain('Your name, speciality, qualifications and certifications were verified');
    expect(el.textContent).not.toContain('MDCN');
  });
});
