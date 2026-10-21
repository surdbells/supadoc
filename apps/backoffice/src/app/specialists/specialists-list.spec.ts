import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { API_CONFIG } from '@supadoc/data-access';
import { provideSupadocIcons } from '@supadoc/ui';
import { AdminSpecialists } from './specialists';

const BASE = 'http://api.test';

@Component({ template: '' })
class Blank {}

describe('AdminSpecialists — list', () => {
  let fixture: ComponentFixture<AdminSpecialists>;
  let el: HTMLElement;
  let http: HttpTestingController;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const page = (total: number) => ({ status: 'success', message: 'OK', data: [], meta: { total, total_pages: 1 } });
  const lists = () => http.match((r) => r.method === 'GET' && r.url === `${BASE}/api/specialists`);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminSpecialists],
      providers: [
        provideRouter([{ path: '', component: Blank }]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
        // No review badge reads.
        { provide: StaffAuthService, useValue: { hasPermission: () => false, isAuthenticated: () => true } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    el?.remove();
  });

  it('shows the all-doctors badge when it opens filtered (a dashboard link), from one tiny unfiltered read', async () => {
    await TestBed.inject(Router).navigateByUrl('/?filter=review');
    fixture = TestBed.createComponent(AdminSpecialists);
    el = fixture.nativeElement;
    await render();
    const [filtered] = lists();
    expect(filtered.request.params.get('filter')).toBe('review');
    filtered.flush(page(2));
    await render();
    const [count] = lists();
    expect(count.request.params.get('filter')).toBeNull();
    expect(count.request.params.get('q')).toBeNull();
    expect(count.request.params.get('per_page')).toBe('1');
    count.flush(page(7));
    await render();
    expect(el.querySelector('h1')?.parentElement?.textContent).toContain('7 doctors');
    expect(el.textContent).toContain('2 doctors · Needs review');
  });

  it('takes the badge from the page itself when the list is unfiltered (no extra read)', async () => {
    fixture = TestBed.createComponent(AdminSpecialists);
    el = fixture.nativeElement;
    await render();
    const [all] = lists();
    expect(all.request.params.get('filter')).toBeNull();
    all.flush(page(5));
    await render();
    expect(lists()).toHaveLength(0);
    expect(el.querySelector('h1')?.parentElement?.textContent).toContain('5 doctors');
  });

  it('numbers the pages: the current one marked, the hidden runs as ellipses', async () => {
    const twelvePages = { status: 'success', message: 'OK', data: [], meta: { total: 240, total_pages: 12 } };
    await TestBed.inject(Router).navigateByUrl('/?page=6');
    fixture = TestBed.createComponent(AdminSpecialists);
    el = fixture.nativeElement;
    await render();
    const [first] = lists();
    expect(first.request.params.get('page')).toBe('6');
    first.flush(twelvePages);
    await render();
    const nav = el.querySelector('nav[aria-label="Specialist pages"]');
    const numbers = [...(nav?.querySelectorAll('ol button') ?? [])].map((b) => b.textContent?.trim());
    expect(numbers).toEqual(['1', '5', '6', '7', '12']);
    const current = nav?.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current?.[0].textContent?.trim()).toBe('6');
    const gaps = nav?.querySelectorAll('li[aria-hidden="true"]');
    expect(gaps).toHaveLength(2);
    expect(gaps?.[0].textContent?.trim()).toBe('…');
    expect(nav?.textContent).toContain('Page 6 of 12');

    (nav?.querySelector('button[aria-label="Page 7"]') as HTMLButtonElement).click();
    await render();
    const [next] = lists();
    expect(next.request.params.get('page')).toBe('7');
    next.flush(twelvePages);
    await render();
    expect(el.querySelector('nav [aria-current="page"]')?.textContent?.trim()).toBe('7');
  });
});
