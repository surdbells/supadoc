import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { API_CONFIG } from '@supadoc/data-access';
import type { DoctorApplicationRowDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { AdminApplications, listParams } from './applications';
import { applicationRow } from './testing';

const BASE = 'http://api.test';
const LIST = `${BASE}/api/doctor-applications`;

@Component({ template: '' })
class Blank {}

describe('AdminApplications — list', () => {
  let fixture: ComponentFixture<AdminApplications>;
  let el: HTMLElement;
  let http: HttpTestingController;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const page = (data: DoctorApplicationRowDto[], total = data.length, totalPages = 1) => ({
    status: 'success',
    message: 'OK',
    data,
    meta: { total, total_pages: totalPages },
  });
  const lists = () => http.match((r) => r.method === 'GET' && r.url === LIST);
  const byText = (text: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.replace(/\s+/g, ' ').trim().startsWith(text));

  async function open(url = '/') {
    await TestBed.inject(Router).navigateByUrl(url);
    fixture = TestBed.createComponent(AdminApplications);
    el = fixture.nativeElement;
    await render();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminApplications],
      providers: [
        provideRouter([{ path: '', component: Blank }]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
        // No queue reads (the shell's badge store stays empty).
        { provide: StaffAuthService, useValue: { hasPermission: () => false, isAuthenticated: () => true } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    el?.remove();
  });

  it('keeps the list query in the URL, defaults left out', () => {
    expect(listParams({ q: ' ada ', filter: 'all', route: '', sort: '', page: 1 })).toEqual({ q: 'ada' });
    expect(listParams({ q: '', filter: 'needs_action', route: 'abroad', sort: 'interview', page: 3 })).toEqual({
      filter: 'needs_action',
      route: 'abroad',
      sort: 'interview',
      page: 3,
    });
  });

  it('opens on the dashboard link (?filter=needs_action) and sorts by the API default', async () => {
    await open('/?filter=needs_action');
    const [filtered] = lists();
    expect(filtered.request.params.get('filter')).toBe('needs_action');
    expect(filtered.request.params.get('sort')).toBeNull();
    expect(filtered.request.params.get('per_page')).toBe('20');
    filtered.flush(page([applicationRow()], 1));
    await render();
    // The header badge: one tiny unfiltered read.
    const [count] = lists();
    expect(count.request.params.get('filter')).toBeNull();
    expect(count.request.params.get('per_page')).toBe('1');
    count.flush(page([], 6));
    await render();
    expect(el.querySelector('h1')?.parentElement?.textContent).toContain('6 applications');
    expect(el.textContent).toContain('1 application · Needs action');
    const selected = Array.from(el.querySelectorAll<HTMLOptionElement>('select option')).filter((o) => o.selected);
    expect(selected.map((o) => o.textContent?.trim())).toContain('Waiting longest');
  });

  it('shows each row: name, reference, specialty, route, status, needs action and the date', async () => {
    await open();
    lists()[0].flush(
      page([
        applicationRow(),
        applicationRow({
          id: 'app-2',
          reference: 'GVM-DR-2026-10044',
          full_name: 'Tunde Bello',
          status: 'interview_scheduled',
          awaiting_staff: false,
          licence_route: 'abroad',
          licence_label: 'Abroad · United Kingdom',
          interview_starts_at: '2026-10-14T09:00:00Z',
        }),
      ]),
    );
    await render();
    const rows = el.querySelectorAll('ul > li > a');
    expect(rows).toHaveLength(2);
    const first = rows[0].textContent ?? '';
    expect(first).toContain('Ada Obi');
    expect(first).toContain('GVM-DR-2026-48213');
    expect(first).toContain('Cardiology');
    expect(first).toContain('Nigeria · MDCN');
    expect(first).toContain('New');
    expect(first).toContain('Needs action');
    expect(first).toContain('Submitted 20 Oct 2026');
    const second = rows[1].textContent ?? '';
    expect(second).toContain('Abroad · United Kingdom');
    expect(second).toContain('Interview scheduled');
    expect(second).not.toContain('Needs action');
    expect(second).toContain('Interview Wed 14 Oct, 10:00 WAT');
    expect(rows[0].getAttribute('href')).toBe('/applications/app-1');
  });

  it('filters by route and status, and sends the search after a pause', async () => {
    await open();
    lists()[0].flush(page([applicationRow()], 1));
    await render();

    byText('Abroad')?.click();
    await render();
    const [byRoute] = lists();
    expect(byRoute.request.params.get('route')).toBe('abroad');
    byRoute.flush(page([], 0));
    await render();

    byText('Under review')?.click();
    await render();
    const [byStatus] = lists();
    expect(byStatus.request.params.get('filter')).toBe('under_review');
    expect(byStatus.request.params.get('route')).toBe('abroad');
    byStatus.flush(page([], 0));
    await render();
    expect(el.textContent).toContain('No applications match these filters.');

    vi.useFakeTimers();
    try {
      const input = el.querySelector<HTMLInputElement>('#bo-applications-search');
      if (!input) throw new Error('No search box');
      input.value = 'GVM-DR-2026';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(lists()).toHaveLength(0);
      vi.advanceTimersByTime(300);
    } finally {
      vi.useRealTimers();
    }
    await render();
    const [searched] = lists();
    expect(searched.request.params.get('q')).toBe('GVM-DR-2026');
    searched.flush(page([], 0));
    await render();

    byText('Clear search and filters')?.click();
    await render();
    const [cleared] = lists();
    expect(cleared.request.params.get('q')).toBeNull();
    expect(cleared.request.params.get('filter')).toBeNull();
    expect(cleared.request.params.get('route')).toBeNull();
    cleared.flush(page([], 0));
    await render();
    expect(el.textContent).toContain('No applications yet');
  });

  it('offers a retry when the list fails', async () => {
    await open();
    lists()[0].flush({ status: 'error', message: 'Database down' }, { status: 500, statusText: 'Server Error' });
    await render();
    expect(el.textContent).toContain("Couldn't load applications");
    byText('Try again')?.click();
    await render();
    lists()[0].flush(page([applicationRow()], 1));
    await render();
    expect(el.textContent).toContain('Ada Obi');
  });
});
