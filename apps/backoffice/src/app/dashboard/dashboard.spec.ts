import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { StaffAuthService } from '@supadoc/auth';
import { API_CONFIG } from '@supadoc/data-access';
import type { AdminDashboardDto, MonitoringOverviewDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { AdminDashboard } from './dashboard';

const BASE = 'http://api.test';

function days(n = 30): AdminDashboardDto['trends'] {
  const list = Array.from({ length: n }, (_, i) => {
    const d = new Date(2026, 8, 17 + i);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { date: ymd, bookings: i % 3, completed: i % 2, revenue: i === n - 1 ? '15000.00' : '0.00' };
  });
  return {
    from: list[0].date,
    to: list[n - 1].date,
    series: ['bookings', 'completed', 'revenue'],
    days: list,
    totals: { bookings: 29, completed: 15, revenue: '15000.00' },
  };
}

/** Everything a super admin gets. */
function full(over: Partial<AdminDashboardDto> = {}): AdminDashboardDto {
  return {
    period: 'today',
    timezone: 'Africa/Lagos',
    currency: 'NGN',
    generated_at: '2026-10-16T09:30:00+01:00',
    range: { from: '', to: '', previous_from: '', previous_to: '' },
    parts: [],
    sections: ['kpis', 'live', 'attention', 'trends', 'breakdowns'],
    unavailable: [],
    kpis: [
      { key: 'bookings', label: 'Bookings made', format: 'count', value: 12, previous: 8, change_pct: 50, trend: 'up', higher_is_better: true, count: null, previous_count: null, breakdown: null },
      { key: 'refunds', label: 'Refunds issued', format: 'money', value: '3000.00', previous: '1000.00', change_pct: 200, trend: 'up', higher_is_better: false, count: 2, previous_count: 1, breakdown: null },
      { key: 'active_doctors', label: 'Active doctors', format: 'count', value: 11, previous: null, change_pct: null, trend: null, higher_is_better: true, count: null, previous_count: null, breakdown: { approved: 14, taking_bookings: 11 } },
    ],
    live: {
      in_progress: [
        {
          id: 'appt-live',
          scheduled_at: '2026-10-16T09:00:00+01:00',
          ends_at: '2026-10-16T09:30:00+01:00',
          status: 'confirmed',
          status_label: 'Confirmed',
          type: 'video',
          patient_name: 'Ada Obi',
          specialist: { id: 's1', name: 'Dr. Grace Bell', specialty: 'Cardiology', photo_url: null },
          in_call: { doctor: true, patient: true, guests: 0 },
        },
      ],
      in_progress_count: 1,
      starting_soon: [],
      starting_soon_count: 0,
      window_minutes: 120,
    },
    attention: [
      { key: 'doctor_reviews_pending', label: 'Doctors waiting for review', description: 'Profiles submitted for approval.', count: 2, amount: null, tone: 'info', link: { path: '/specialists', query: { filter: 'review' } } },
      { key: 'licences_expired', label: 'Licences expired', description: 'Run out.', count: 1, amount: null, tone: 'alert', link: { path: '/specialists', query: { filter: 'licence_expired' } } },
      { key: 'support_open', label: 'Open support tickets', description: 'Waiting.', count: 0, amount: null, tone: 'info', link: { path: '/support', query: { status: 'open' } } },
      { key: 'topups_held', label: 'Wallet top-ups held for review', description: 'Not credited.', count: 1, amount: '5000.00', tone: 'alert', link: null },
    ],
    trends: days(),
    breakdowns: {
      from: '',
      to: '',
      by_status: [
        { status: 'pending', label: 'Pending', count: 1 },
        { status: 'confirmed', label: 'Confirmed', count: 3 },
        { status: 'rescheduled', label: 'Rescheduled', count: 0 },
        { status: 'completed', label: 'Completed', count: 4 },
        { status: 'missed', label: 'Missed', count: 0 },
        { status: 'cancelled', label: 'Cancelled', count: 0 },
      ],
      top_specialties: [{ specialty: 'Cardiology', bookings: 5, completed: 3, revenue: '30000.00' }],
      top_doctors: [
        { id: 's1', name: 'Dr. Grace Bell', specialty: 'Cardiology', photo_url: null, rating: '4.80', reviews_count: 12, bookings: 5, consultations: 3, revenue: '30000.00', doctor_no_shows: 1, patient_no_shows: 0 },
      ],
      recent_activity: [
        { id: 'e1', action: 'specialist.approved', label: 'Doctor approved', summary: 'Doctor approved · Dr. Grace Bell', actor_name: 'Ada Admin', actor_role: 'super_admin', created_at: '2026-10-16T08:00:00+01:00', link: { path: '/specialists/s1', query: {} } },
      ],
    },
    ...over,
  };
}

function overview(activeRecordings = 0): MonitoringOverviewDto {
  return {
    appointments: { total: 0, by_status: {} },
    clinical_notes: 0,
    prescriptions: 0,
    lab_orders: 0,
    referrals: 0,
    recordings: { total: activeRecordings, active: activeRecordings },
    audit_events: 0,
  };
}

describe('AdminDashboard', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let el: HTMLElement;

  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const render = async () => {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  };
  const isDashboardGet = (r: { method: string; url: string }) =>
    r.method === 'GET' && r.url === `${BASE}/api/admin/dashboard`;
  const isOverviewGet = (r: { method: string; url: string }) =>
    r.method === 'GET' && r.url === `${BASE}/api/admin/monitoring/overview`;
  const expectGet = (period: string, refresh = false): TestRequest =>
    http.expectOne(
      (r) => isDashboardGet(r) && r.params.get('period') === period && (r.params.get('refresh') === '1') === refresh,
    );
  /** Answers the recording check that goes with each load (superseded ones were cancelled). */
  const flushOverview = (activeRecordings = 0): number => {
    let flushed = 0;
    for (const r of http.match(isOverviewGet)) {
      if (r.cancelled) continue;
      r.flush({ status: 'success', message: 'OK', data: overview(activeRecordings) });
      flushed++;
    }
    return flushed;
  };
  const ok = async (req: TestRequest, data: AdminDashboardDto, activeRecordings = 0) => {
    req.flush({ status: 'success', message: 'OK', data });
    flushOverview(activeRecordings);
    await render();
    await tick();
    await render();
  };
  const text = () => el.textContent?.replace(/\s+/g, ' ') ?? '';

  async function open(url = '/dashboard', can: (permission: string) => boolean = () => true): Promise<void> {
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'dashboard', component: AdminDashboard },
          { path: '**', children: [] },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
        { provide: StaffAuthService, useValue: { hasPermission: can, displayName: signal('Ada Admin') } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    el = harness.routeNativeElement as HTMLElement;
    await render();
  }

  afterEach(() => http.verify());

  it('shows skeletons first, then every section the API sent', async () => {
    await open();
    expect(el.querySelector('[aria-busy="true"]')).not.toBeNull();
    await ok(expectGet('today'), full());

    const t = text();
    expect(t).toContain('Good');
    expect(t).toContain('Bookings made');
    expect(t).toContain('Up 50%');
    expect(t).toContain('vs this time yesterday');
    // A snapshot tile has no change, says so, and shows its breakdown.
    expect(t).toContain('Right now');
    expect(t).toContain('of 14 approved');
    expect(t).toContain('Live now');
    expect(t).toContain('Both in the call');
    expect(t).toContain('Needs your attention');
    expect(t).toContain('Bookings vs completed');
    expect(t).toContain('Appointments by status');
    expect(t).toContain('Top specialties');
    expect(t).toContain('Top doctors');
    expect(t).toContain('Doctor approved · Dr. Grace Bell');

    // Attention rows link to the already-filtered pages; urgent (alert) first; empty queues are "All clear".
    const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('section[aria-labelledby="dash-attention-title"] a'));
    const hrefs = links.map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/specialists?filter=review');
    expect(hrefs).toContain('/specialists?filter=licence_expired');
    expect(hrefs.indexOf('/specialists?filter=licence_expired')).toBeLessThan(hrefs.indexOf('/specialists?filter=review'));
    expect(t).toContain('All clear');
    expect(t).toContain('No back-office list for these yet');
    // The live consultation opens its appointment.
    expect(el.querySelector('a[href="/appointments/appt-live"]')).not.toBeNull();
    // Charts are inline SVG with a table fallback.
    expect(el.querySelectorAll('bo-dash-trend-chart [role="group"] > svg').length).toBe(2);
    expect(el.querySelectorAll('bo-dash-trend-chart [role="group"] > svg path').length).toBeGreaterThan(10);
    expect(el.querySelectorAll('bo-dash-trend-chart table').length).toBe(2);
  });

  it('leaves out what the API left out (permissions)', async () => {
    await open();
    await ok(
      expectGet('today'),
      full({ sections: ['attention'], kpis: undefined, live: undefined, trends: undefined, breakdowns: undefined }),
    );
    const t = text();
    expect(t).toContain('Needs your attention');
    expect(t).not.toContain('Live now');
    expect(t).not.toContain('Bookings vs completed');
    expect(t).not.toContain('Top doctors');
    expect(el.querySelector('bo-dash-kpis')).toBeNull();
  });

  it('reads the period from the URL and switches it there (deep link)', async () => {
    await open('/dashboard?period=7d');
    await ok(expectGet('7d'), full({ period: '7d' }));
    expect(text()).toContain('vs previous 7 days');
    const pressed = el.querySelector('[role="group"][aria-label="Period"] [aria-pressed="true"]');
    expect(pressed?.textContent?.trim()).toBe('7 days');

    const thirty = Array.from(el.querySelectorAll<HTMLButtonElement>('[aria-label="Period"] button')).find((b) => b.textContent?.trim() === '30 days');
    thirty?.click();
    await render();
    await tick();
    expect(TestBed.inject(Router).url).toBe('/dashboard?period=30d');
    // The old figures stay on screen (dimmed) while the new ones load.
    expect(text()).toContain('Bookings made');
    await ok(expectGet('30d'), full({ period: '30d' }));
    expect(text()).toContain('vs previous 30 days');
  });

  it('shows an error with a retry that skips the cache, and names sections that failed', async () => {
    await open();
    expectGet('today').flush({ message: 'Server error' }, { status: 500, statusText: 'Server Error' });
    await render();
    expect(text()).toContain("Couldn't load the dashboard");

    const retry = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Try again'));
    retry?.click();
    await render();
    await ok(expectGet('today', true), full({ unavailable: ['trends'], trends: undefined }));
    expect(text()).toContain("Some sections couldn't load just now: Trends.");
    expect(text()).not.toContain("Couldn't load the dashboard");
  });

  it('reads a chart day by day from the keyboard', async () => {
    await open();
    await ok(expectGet('today'), full());
    const chart = el.querySelector<HTMLElement>('bo-dash-trend-chart [role="group"]');
    expect(chart?.getAttribute('aria-label')).toContain('arrow keys');
    chart?.dispatchEvent(new FocusEvent('focus'));
    await render();
    const live = () => el.querySelector('bo-dash-trend-chart [aria-live="polite"]')?.textContent ?? '';
    // Focus starts on today (the last day).
    expect(live()).toContain('Booked 2');
    chart?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await render();
    expect(live()).toContain('Booked 0, Completed 0');
  });

  it('keeps a tapped day on screen when the finger lifts; a mouse leaving or a tap outside clears it', async () => {
    await open();
    await ok(expectGet('today'), full());
    const chart = el.querySelector<HTMLElement>('bo-dash-trend-chart [role="group"]');
    const svg = chart?.querySelector('svg');
    const tooltip = () => chart?.querySelector(':scope > div');
    const leave = (pointerType: string) => {
      const ev = new Event('pointerleave');
      Object.defineProperty(ev, 'pointerType', { value: pointerType });
      svg?.dispatchEvent(ev);
    };
    chart?.dispatchEvent(new FocusEvent('focus'));
    await render();
    expect(tooltip()).not.toBeNull();

    leave('touch');
    await render();
    expect(tooltip()).not.toBeNull();

    leave('mouse');
    await render();
    expect(tooltip()).toBeNull();

    chart?.dispatchEvent(new FocusEvent('focus'));
    await render();
    expect(tooltip()).not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await render();
    expect(tooltip()).toBeNull();
  });

  it('warns when consultations are being recorded, linking to monitoring', async () => {
    await open();
    await ok(expectGet('today'), full(), 2);
    const notice = el.querySelector<HTMLAnchorElement>('a[href="/monitoring"]');
    expect(text()).toContain('2 consultations recording now');
    expect(notice?.textContent).toContain('recording now');
  });

  it('shows no recording notice and makes no monitoring read without monitoring.view', async () => {
    await open('/dashboard', (p) => p !== 'monitoring.view');
    const req = expectGet('today');
    expect(flushOverview(3)).toBe(0);
    await ok(req, full({ sections: ['attention'], kpis: undefined, live: undefined, trends: undefined, breakdowns: undefined }));
    expect(text()).not.toContain('recording now');
    expect(el.querySelector('a[href="/audit"]')).toBeNull();
  });

  it('refreshes quietly on returning to the tab once the figures are stale', async () => {
    await open();
    await ok(expectGet('today'), full());
    const start = Date.now();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    try {
      // Just loaded: coming back straight away asks for nothing.
      document.dispatchEvent(new Event('visibilitychange'));
      await render();
      expect(http.match(isDashboardGet).length).toBe(0);

      // 25 s later (past the 20 s "live now" cache): one quiet request, no cache skip.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start + 25_000);
      try {
        document.dispatchEvent(new Event('visibilitychange'));
        await render();
        await ok(expectGet('today', false), full(), 1);
      } finally {
        clock.mockRestore();
      }
      expect(text()).toContain('1 consultation recording now');
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });
});
