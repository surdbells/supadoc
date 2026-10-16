import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { API_CONFIG } from '@supadoc/data-access';
import type { ReferenceItemDto, SpecialistAdminDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { AdminSpecialists } from './specialists';

const BASE = 'http://api.test';

function ref(label: string, active = true): ReferenceItemDto {
  return {
    id: label.toLowerCase(),
    category: 'specialty',
    code: label.toLowerCase(),
    label,
    sort_order: 10,
    active,
    usage_count: 0,
    created_at: null,
    updated_at: null,
  };
}

const CREATED = {
  id: 's1',
  name: 'Dr Ada Obi',
  specialty: 'Cardiology',
  email: null,
  photo_url: null,
  consultation_fee: '0.00',
  status: 'invited',
} as unknown as SpecialistAdminDto;

describe('AdminSpecialists — New specialist', () => {
  let fixture: ComponentFixture<AdminSpecialists>;
  let el: HTMLElement;
  let http: HttpTestingController;

  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const ok = <T>(data: T) => ({ status: 'success', message: 'OK', data });
  const one = <T extends Element>(selector: string): T => {
    const found = el.querySelector<T>(selector);
    if (!found) throw new Error(`No ${selector}`);
    return found;
  };
  /** Answer every list read (the page re-reads after each change; a newer read cancels an older one). */
  const flushLists = () => {
    for (const req of http.match((r) => r.method === 'GET' && r.url === `${BASE}/api/specialists`)) {
      if (!req.cancelled) req.flush({ status: 'success', message: 'OK', data: [], meta: { total: 0, total_pages: 1 } });
    }
  };
  const byText = (text: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);

  const openCreate = async (items: ReferenceItemDto[]) => {
    byText('New specialist')?.click();
    await render();
    http.expectOne(`${BASE}/api/reference/specialty`).flush(ok(items));
    await render();
    await tick();
    await render();
  };
  const typeName = async (name: string) => {
    const input = one<HTMLInputElement>('input[placeholder="Dr Jane Doe"]');
    input.value = name;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  const chooseSpecialty = async (label: string) => {
    const trigger = one<HTMLButtonElement>('sd-search-select button');
    trigger.click();
    await render();
    byText(label)?.click();
    await render();
  };
  const pickFile = async (file: File) => {
    const input = one<HTMLInputElement>('sd-file-drop input[type="file"]');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await render();
  };
  const submit = async () => {
    el.querySelector<HTMLFormElement>('#bo-create-specialist')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
  };

  beforeEach(async () => {
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    await TestBed.configureTestingModule({
      imports: [AdminSpecialists],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
        // No review badge reads.
        { provide: StaffAuthService, useValue: { hasPermission: () => false } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AdminSpecialists);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    http = TestBed.inject(HttpTestingController);
    await render();
    flushLists();
    await render();
  });

  afterEach(() => {
    http.verify();
    el.remove();
  });

  it('offers only active specialties, labels the dropdown, and sends no photo link', async () => {
    await openCreate([ref('Cardiology'), ref('Homeopathy', false)]);
    const trigger = one<HTMLButtonElement>('sd-search-select button');
    expect(trigger.getAttribute('aria-labelledby')).toContain('bo-new-spec-label');
    trigger.click();
    await render();
    expect(byText('Cardiology')).toBeTruthy();
    expect(byText('Homeopathy')).toBeUndefined();
    byText('Cardiology')?.click();
    await render();
    await typeName('Dr Ada Obi');
    await submit();
    const req = http.expectOne((r) => r.method === 'POST' && r.url === `${BASE}/api/specialists`);
    expect(req.request.body.specialty).toBe('Cardiology');
    expect('photo_url' in req.request.body).toBe(false);
    req.flush(ok(CREATED));
    await render();
    flushLists();
    // No photo chosen: nothing else is uploaded.
    http.expectNone((r) => r.url.endsWith('/photo'));
  });

  it('asks for a specialty from the list before creating', async () => {
    await openCreate([ref('Cardiology')]);
    await typeName('Dr Ada Obi');
    await submit();
    http.expectNone((r) => r.method === 'POST');
    expect(el.textContent).toContain('Choose their specialty.');
  });

  it('picks the first match on Enter in the dropdown search box, without submitting the form', async () => {
    await openCreate([ref('Cardiology'), ref('Dermatology')]);
    await typeName('Dr Ada Obi');
    one<HTMLButtonElement>('sd-search-select button').click();
    await render();
    const search = one<HTMLInputElement>('sd-search-select .sd-menu input');
    search.value = 'derm';
    search.dispatchEvent(new Event('input'));
    await render();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    search.dispatchEvent(enter);
    await render();
    // Default prevented = no implicit submission of the surrounding form.
    expect(enter.defaultPrevented).toBe(true);
    http.expectNone((r) => r.method === 'POST');
    expect(el.querySelector('sd-search-select .sd-menu')).toBeNull();
    expect(one('sd-search-select button').textContent).toContain('Dermatology');
    expect(one('sd-search-select button').getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('says to wait when the specialty list is still loading', async () => {
    byText('New specialist')?.click();
    await render();
    await typeName('Dr Ada Obi');
    await submit();
    http.expectNone((r) => r.method === 'POST');
    expect(el.textContent).toContain('Wait for the specialty list to load, then choose one.');
    http.expectOne(`${BASE}/api/reference/specialty`).flush(ok([ref('Cardiology')]));
    await render();
  });

  it('describes the photo drop zone with the file rule, and the refusal when there is one', async () => {
    await openCreate([ref('Cardiology')]);
    const zone = one<HTMLButtonElement>('sd-file-drop button');
    const describedBy = () => (zone.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(describedBy()).toHaveLength(1);
    expect(document.getElementById(describedBy()[0])?.textContent).toContain('JPG, PNG or WebP, up to 2 MB');
    await pickFile(new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' }));
    await render();
    expect(describedBy()).toHaveLength(2);
    expect(document.getElementById(describedBy()[1])?.textContent).toContain('Only JPG, PNG or WEBP images are allowed.');
  });

  it('uploads the chosen photo right after the specialist is created', async () => {
    await openCreate([ref('Cardiology')]);
    await chooseSpecialty('Cardiology');
    await typeName('Dr Ada Obi');
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'ada.jpg', { type: 'image/jpeg' });
    await pickFile(file);
    expect(el.querySelector('bo-photo-picker img')?.getAttribute('src')).toBe('blob:preview');
    await submit();
    http.expectOne((r) => r.method === 'POST' && r.url === `${BASE}/api/specialists`).flush(ok(CREATED));
    await render();
    const upload = http.expectOne((r) => r.method === 'POST' && r.url === `${BASE}/api/specialists/s1/photo`);
    const body = upload.request.body as FormData;
    expect(body.get('photo')).toBeInstanceOf(File);
    expect((body.get('photo') as File).name).toBe('ada.jpg');
    upload.flush(ok({ ...CREATED, photo_url: '/uploads/avatars/dr-s1-abcd1234.jpg' }));
    await render();
    flushLists();
    await render();
    expect(el.textContent).toContain('Photo added.');
  });

  it("doesn't announce every percentage while the photo uploads", async () => {
    await openCreate([ref('Cardiology')]);
    await chooseSpecialty('Cardiology');
    await typeName('Dr Ada Obi');
    await pickFile(new File([new Uint8Array([0xff, 0xd8, 0xff])], 'ada.jpg', { type: 'image/jpeg' }));
    await submit();
    http.expectOne((r) => r.method === 'POST' && r.url === `${BASE}/api/specialists`).flush(ok(CREATED));
    await render();
    flushLists();
    const pct = Array.from(el.querySelectorAll('[aria-live="polite"] span')).find((s) => /%$/.test(s.textContent?.trim() ?? ''));
    expect(pct?.getAttribute('aria-hidden')).toBe('true');
    http.expectOne(`${BASE}/api/specialists/s1/photo`).flush(ok({ ...CREATED, photo_url: '/uploads/avatars/dr-s1-1.jpg' }));
    await render();
    flushLists();
  });

  it('refuses a file that is not an image before uploading anything', async () => {
    await openCreate([ref('Cardiology')]);
    await pickFile(new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' }));
    expect(el.textContent).toContain('Only JPG, PNG or WEBP images are allowed.');
    expect(el.querySelector('bo-photo-picker img')).toBeNull();
  });

  it('keeps the specialist and offers a retry when the upload is refused', async () => {
    await openCreate([ref('Cardiology')]);
    await chooseSpecialty('Cardiology');
    await typeName('Dr Ada Obi');
    await pickFile(new File([new Uint8Array([1, 2, 3])], 'ada.png', { type: 'image/png' }));
    await submit();
    http.expectOne((r) => r.method === 'POST' && r.url === `${BASE}/api/specialists`).flush(ok(CREATED));
    await render();
    flushLists();
    http
      .expectOne(`${BASE}/api/specialists/s1/photo`)
      .flush(
        { status: 'error', message: 'Validation failed', errors: { photo: 'Only JPG, PNG or WEBP images are allowed' } },
        { status: 422, statusText: 'Unprocessable Entity' },
      );
    await render();
    expect(el.textContent).toContain('Dr Ada Obi was created.');
    expect(el.textContent).toContain("The photo wasn't added: Only JPG, PNG or WEBP images are allowed.");
    byText('Try the upload again')?.click();
    await render();
    http.expectOne(`${BASE}/api/specialists/s1/photo`).flush(ok({ ...CREATED, photo_url: '/uploads/avatars/dr-s1-1.png' }));
    await render();
    flushLists();
  });
});
