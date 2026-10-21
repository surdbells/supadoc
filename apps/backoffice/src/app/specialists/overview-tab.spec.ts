import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { API_CONFIG } from '@supadoc/data-access';
import type { ReferenceItemDto, SpecialistDetailDto } from '@supadoc/models';
import { DialogService, provideSupadocIcons, type ConfirmOptions } from '@supadoc/ui';
import { firstValueFrom, isObservable } from 'rxjs';
import { SpecialistOverviewTab } from './tabs/overview-tab';

const BASE = 'http://api.test';

function ref(label: string, active = true): ReferenceItemDto {
  return {
    id: label.toLowerCase(),
    category: 'specialty',
    code: label.toLowerCase(),
    label,
    sort_order: 10,
    active,
    usage_count: 1,
    created_at: null,
    updated_at: null,
  };
}

function detail(over: { specialty?: string; photo_url?: string | null; locked?: boolean } = {}): SpecialistDetailDto {
  return {
    status: over.locked ? 'approved' : 'invited',
    locked_fields: over.locked ? ['name', 'specialty'] : [],
    pending_changes: null,
    checklist: { availability: false },
    login: null,
    profile: {
      id: 's1',
      name: 'Dr Ada Obi',
      specialty: over.specialty ?? 'Homeopathy',
      email: 'ada@example.com',
      consultation_fee: '15000.00',
      photo_url: over.photo_url ?? null,
      available: true,
      weekly_hours: {},
      expertise: [],
    },
  } as unknown as SpecialistDetailDto;
}

@Component({
  imports: [SpecialistOverviewTab],
  template: `<bo-specialist-overview [detail]="d()" (updated)="updates.push($event)" />`,
})
class HostComponent {
  readonly d = signal<SpecialistDetailDto>(detail());
  readonly updates: Partial<SpecialistDetailDto>[] = [];
}

describe('SpecialistOverviewTab — specialty and photo', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;
  let http: HttpTestingController;
  let asked: ConfirmOptions[];

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
  const byText = (text: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);
  const start = async (d: SpecialistDetailDto, items: ReferenceItemDto[]) => {
    host.d.set(d);
    await render();
    http.expectOne(`${BASE}/api/reference/specialty`).flush(ok(items));
    await render();
  };

  beforeEach(async () => {
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
        { provide: StaffAuthService, useValue: { hasPermission: () => false, isAuthenticated: () => true } },
      ],
    }).compileComponents();
    asked = [];
    vi.spyOn(TestBed.inject(DialogService), 'confirm').mockImplementation(async (options: ConfirmOptions) => {
      asked.push(options);
      if (options.action) {
        const pending = options.action();
        await (isObservable(pending) ? firstValueFrom(pending) : pending);
      }
      return { confirmed: true };
    });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    el.remove();
  });

  it('keeps a switched-off specialty, marked, and sends a new one from the list', async () => {
    await start(detail({ specialty: 'Homeopathy' }), [ref('Cardiology'), ref('Homeopathy', false)]);
    expect(el.textContent).toContain('“Homeopathy” has been switched off in the list.');
    const trigger = one<HTMLButtonElement>('sd-search-select button');
    expect(trigger.textContent).toContain('Homeopathy (switched off)');
    trigger.click();
    await render();
    byText('Cardiology')?.click();
    await render();
    el.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
    const req = http.expectOne((r) => r.method === 'PATCH' && r.url === `${BASE}/api/specialists/s1`);
    expect(req.request.body).toEqual({ specialty: 'Cardiology' });
    req.flush(ok({ id: 's1', specialty: 'Cardiology' }));
    await render();
  });

  it('has no specialty field once the doctor is approved (it is locked)', async () => {
    await start(detail({ locked: true }), [ref('Cardiology')]);
    expect(el.querySelector('sd-search-select')).toBeNull();
    expect(el.textContent).not.toContain('Photo URL');
  });

  it('uploads a photo straight away and tells the page', async () => {
    await start(detail(), [ref('Cardiology')]);
    const input = one<HTMLInputElement>('sd-file-drop input[type="file"]');
    Object.defineProperty(input, 'files', {
      value: [new File([new Uint8Array([1, 2, 3])], 'ada.webp', { type: 'image/webp' })],
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await render();
    expect(el.querySelector('[role="progressbar"]')).not.toBeNull();
    const upload = http.expectOne((r) => r.method === 'POST' && r.url === `${BASE}/api/specialists/s1/photo`);
    upload.flush(ok({ id: 's1', photo_url: '/uploads/avatars/dr-s1-abcd1234.webp' }));
    await render();
    expect(host.updates[0]?.profile?.photo_url).toBe('/uploads/avatars/dr-s1-abcd1234.webp');
    expect(el.textContent).toContain('Photo added.');
    // Then the page is re-read (the onboarding checklist counts the photo).
    http.expectOne((r) => r.method === 'GET' && r.url === `${BASE}/api/specialists/s1`).flush(ok(detail({ photo_url: '/uploads/avatars/dr-s1-abcd1234.webp' })));
    await render();
  });

  it('asks before leaving while a photo is still uploading', async () => {
    await start(detail(), [ref('Cardiology')]);
    const tab = fixture.debugElement.query(By.directive(SpecialistOverviewTab)).componentInstance as SpecialistOverviewTab;
    expect(tab.hasUnsavedChanges()).toBe(false);
    const input = one<HTMLInputElement>('sd-file-drop input[type="file"]');
    Object.defineProperty(input, 'files', {
      value: [new File([new Uint8Array([1, 2, 3])], 'ada.png', { type: 'image/png' })],
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await render();
    expect(tab.hasUnsavedChanges()).toBe(true);
    expect(tab.leaveCopy().title).toBe('Leave while the photo uploads?');
    http.expectOne(`${BASE}/api/specialists/s1/photo`).flush(ok({ id: 's1', photo_url: '/uploads/avatars/dr-s1-1.png' }));
    await render();
    expect(tab.hasUnsavedChanges()).toBe(false);
    http.expectOne((r) => r.method === 'GET' && r.url === `${BASE}/api/specialists/s1`).flush(ok(detail({ photo_url: '/uploads/avatars/dr-s1-1.png' })));
    await render();
  });

  it('removes the photo after confirming', async () => {
    await start(detail({ photo_url: '/uploads/avatars/dr-s1-abcd1234.jpg' }), [ref('Cardiology')]);
    byText('Remove photo')?.click();
    await render();
    await tick();
    expect(asked[0]?.tone).toBe('danger');
    http.expectOne((r) => r.method === 'DELETE' && r.url === `${BASE}/api/specialists/s1/photo`).flush(ok({ id: 's1', photo_url: null }));
    await tick();
    await render();
    expect(host.updates[0]?.profile?.photo_url).toBeNull();
    http.expectOne((r) => r.method === 'GET' && r.url === `${BASE}/api/specialists/s1`).flush(ok(detail()));
    await render();
  });
});
