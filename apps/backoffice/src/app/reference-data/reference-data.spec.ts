import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { API_CONFIG } from '@supadoc/data-access';
import type { ReferenceItemDto } from '@supadoc/models';
import { DialogService, provideSupadocIcons, type ConfirmOptions } from '@supadoc/ui';
import { firstValueFrom, isObservable } from 'rxjs';
import { AdminReferenceData } from './reference-data';

const BASE = 'http://api.test';
const LIST = `${BASE}/api/reference/specialty`;

function item(over: Partial<ReferenceItemDto>): ReferenceItemDto {
  return {
    id: 'x',
    category: 'specialty',
    code: 'x',
    label: 'X',
    sort_order: 10,
    active: true,
    usage_count: 0,
    created_at: '2026-10-01T09:00:00Z',
    updated_at: '2026-10-01T09:00:00Z',
    ...over,
  };
}

const CARDIO = item({ id: 'c1', code: 'cardiology', label: 'Cardiology', sort_order: 10, usage_count: 3 });
const DERM = item({ id: 'd1', code: 'dermatology', label: 'Dermatology', sort_order: 20 });
const HOMEO = item({ id: 'h1', code: 'homeopathy', label: 'Homeopathy', sort_order: 30, active: false, usage_count: 1 });

describe('AdminReferenceData', () => {
  let fixture: ComponentFixture<AdminReferenceData>;
  let el: HTMLElement;
  let http: HttpTestingController;
  let asked: ConfirmOptions[];
  /** Permissions the signed-in person has (settings.manage is implied by the route). */
  let perms: Set<string>;

  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const ok = <T>(req: TestRequest, data: T) => req.flush({ status: 'success', message: 'OK', data });
  const one = <T extends Element>(selector: string): T => {
    const found = el.querySelector<T>(selector);
    if (!found) throw new Error(`No ${selector}`);
    return found;
  };
  const button = (label: string) => {
    const b = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (x) => x.getAttribute('aria-label') === label || x.textContent?.replace(/\s+/g, ' ').trim() === label,
    );
    if (!b) throw new Error(`No "${label}" button`);
    return b;
  };
  const typeInto = async (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  const submit = async (form: HTMLFormElement | null) => {
    form?.dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
    await tick();
    await render();
  };
  const rows = () => Array.from(el.querySelectorAll('ul > li')).map((li) => li.querySelector('.font-heading')?.textContent?.trim());

  beforeEach(async () => {
    perms = new Set(['settings.manage']);
    await TestBed.configureTestingModule({
      imports: [AdminReferenceData],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
        { provide: StaffAuthService, useValue: { hasPermission: (p: string) => perms.has(p), isAuthenticated: () => true } },
      ],
    }).compileComponents();
    asked = [];
    // Every confirmation is answered "yes" (running its action, as the real dialog does).
    vi.spyOn(TestBed.inject(DialogService), 'confirm').mockImplementation(async (options: ConfirmOptions) => {
      asked.push(options);
      if (options.action) {
        const pending = options.action();
        await (isObservable(pending) ? firstValueFrom(pending) : pending);
      }
      return { confirmed: true };
    });
    fixture = TestBed.createComponent(AdminReferenceData);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    http = TestBed.inject(HttpTestingController);
    await render();
    ok(http.expectOne((r) => r.method === 'GET' && r.url === LIST), [DERM, CARDIO, HOMEO]);
    await render();
  });

  afterEach(() => {
    http.verify();
    el.remove();
  });

  it('lists every item in list order, with usage and status in words', () => {
    expect(rows()).toEqual(['Cardiology', 'Dermatology', 'Homeopathy']);
    const text = el.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('3 specialties');
    expect(text).toContain('3 doctors');
    expect(text).toContain('Not used');
    expect(text).toContain('Switched off');
    expect(button('Move Cardiology up').disabled).toBe(true);
    expect(button('Move Homeopathy down').disabled).toBe(true);
  });

  it('adds an item at the end of the list', async () => {
    const input = one<HTMLInputElement>('input[placeholder="e.g. Cardiology"]');
    await typeInto(input, '  Neurology ');
    await submit(input.closest('form'));
    const req = http.expectOne((r) => r.method === 'POST' && r.url === LIST);
    expect(req.request.body).toEqual({ label: 'Neurology' });
    ok(req, item({ id: 'n1', code: 'neurology', label: 'Neurology', sort_order: 40 }));
    await render();
    expect(rows()).toEqual(['Cardiology', 'Dermatology', 'Homeopathy', 'Neurology']);
    expect(input.value).toBe('');
  });

  it('refuses a duplicate before asking the API, and offers to switch a switched-off one back on', async () => {
    const input = one<HTMLInputElement>('input[placeholder="e.g. Cardiology"]');
    await typeInto(input, 'HOMEOPATHY');
    await submit(input.closest('form'));
    http.expectNone((r) => r.method === 'POST');
    expect(el.textContent).toContain('already in the list but switched off');
    button('Switch “Homeopathy” back on').click();
    await render();
    const req = http.expectOne((r) => r.method === 'PATCH' && r.url === `${LIST}/h1`);
    expect(req.request.body).toEqual({ active: true });
    ok(req, { ...HOMEO, active: true });
    await render();
    expect(input.value).toBe('');
  });

  it('moves an item and saves the whole order', async () => {
    button('Move Cardiology down').click();
    await render();
    expect(rows()).toEqual(['Dermatology', 'Cardiology', 'Homeopathy']);
    const req = http.expectOne((r) => r.method === 'POST' && r.url === `${LIST}/reorder`);
    expect(req.request.body).toEqual({ ids: ['d1', 'c1', 'h1'] });
    ok(req, [
      { ...DERM, sort_order: 10 },
      { ...CARDIO, sort_order: 20 },
      { ...HOMEO, sort_order: 30 },
    ]);
    await render();
    expect(rows()).toEqual(['Dermatology', 'Cardiology', 'Homeopathy']);
  });

  it('asks before renaming an item doctors use, then renames it', async () => {
    one<HTMLButtonElement>('#bo-ref-rename-c1').click();
    await render();
    const field = one<HTMLInputElement>('#bo-ref-edit-c1');
    await typeInto(field, 'Cardiology (Heart)');
    await submit(field.closest('form'));
    expect(asked[0]?.title).toBe('Rename “Cardiology” to “Cardiology (Heart)”?');
    const req = http.expectOne((r) => r.method === 'PATCH' && r.url === `${LIST}/c1`);
    expect(req.request.body).toEqual({ label: 'Cardiology (Heart)' });
    ok(req, { ...CARDIO, label: 'Cardiology (Heart)', specialists_updated: 3 });
    await render();
    expect(rows()[0]).toBe('Cardiology (Heart)');
    expect(el.textContent).toContain('3 doctors updated');
  });

  it("won't delete an item in use — it offers to switch it off instead", async () => {
    one<HTMLButtonElement>('#bo-ref-delete-c1').click();
    await render();
    await tick();
    const req = http.expectOne((r) => r.method === 'PATCH' && r.url === `${LIST}/c1`);
    expect(req.request.body).toEqual({ active: false });
    ok(req, { ...CARDIO, active: false });
    await tick();
    await render();
    http.expectNone((r) => r.method === 'DELETE');
    expect(asked[0]?.confirmLabel).toBe('Switch it off');
  });

  it('deletes an unused item after confirming', async () => {
    one<HTMLButtonElement>('#bo-ref-delete-d1').click();
    await render();
    await tick();
    expect(asked[0]?.tone).toBe('danger');
    ok(http.expectOne((r) => r.method === 'DELETE' && r.url === `${LIST}/d1`), { id: 'd1' });
    await tick();
    await render();
    expect(rows()).toEqual(['Cardiology', 'Homeopathy']);
  });

  it('keeps a rename made while a reorder was being saved (only the order numbers are taken)', async () => {
    button('Move Cardiology down').click();
    await render();
    const reorder = http.expectOne((r) => r.method === 'POST' && r.url === `${LIST}/reorder`);
    // Rename Dermatology while the order is still being saved.
    one<HTMLButtonElement>('#bo-ref-rename-d1').click();
    await render();
    const field = one<HTMLInputElement>('#bo-ref-edit-d1');
    await typeInto(field, 'Skin');
    await submit(field.closest('form'));
    ok(http.expectOne((r) => r.method === 'PATCH' && r.url === `${LIST}/d1`), { ...DERM, label: 'Skin' });
    await render();
    // The reorder's snapshot predates the rename.
    ok(reorder, [
      { ...DERM, sort_order: 10 },
      { ...CARDIO, sort_order: 20 },
      { ...HOMEO, sort_order: 30 },
    ]);
    await render();
    expect(rows()).toEqual(['Skin', 'Cardiology', 'Homeopathy']);
  });

  it('reads outcomes out from a live region that is already on the page', async () => {
    const region = el.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    one<HTMLButtonElement>('#bo-ref-delete-d1').click();
    await render();
    await tick();
    ok(http.expectOne((r) => r.method === 'DELETE' && r.url === `${LIST}/d1`), { id: 'd1' });
    await tick();
    await render();
    expect(el.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region?.textContent).toContain('Deleted “Dermatology”.');
  });

  it('offers to show the doctors who still have a switched-off item it cannot delete', async () => {
    perms.add('specialists.manage');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    one<HTMLButtonElement>('#bo-ref-delete-h1').click();
    await render();
    await tick();
    expect(asked[0]?.confirmLabel).toBe('Show this doctor');
    expect(asked[0]?.cancelLabel).toBe('Close');
    expect(navigate).toHaveBeenCalledWith(['/specialists'], { queryParams: { q: 'Homeopathy' } });
    http.expectNone((r) => r.method === 'DELETE');
  });

  it('explains inline, without a dialog, when the doctor list is not open to this person', async () => {
    one<HTMLButtonElement>('#bo-ref-delete-h1').click();
    await render();
    await tick();
    expect(asked).toEqual([]);
    expect(el.querySelector('[aria-live="polite"]')?.textContent).toContain("“Homeopathy” can't be deleted: 1 doctor has it.");
    http.expectNone((r) => r.method === 'DELETE');
  });

  it('reports typed-but-unsaved names to the leave guard', async () => {
    expect(fixture.componentInstance.hasUnsavedChanges()).toBe(false);
    const input = one<HTMLInputElement>('input[placeholder="e.g. Cardiology"]');
    await typeInto(input, 'Neuro');
    expect(fixture.componentInstance.hasUnsavedChanges()).toBe(true);
  });
});
