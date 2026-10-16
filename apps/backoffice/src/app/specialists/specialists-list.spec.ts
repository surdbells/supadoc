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
        { provide: StaffAuthService, useValue: { hasPermission: () => false } },
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
});
