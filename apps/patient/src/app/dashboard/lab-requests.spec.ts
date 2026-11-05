import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import {
  API_CONFIG,
  LabRequestsApi,
  type PatientLabListQuery,
} from '@supadoc/data-access';
import type {
  LabListGroup,
  PatientLabRequestSummaryDto,
} from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { LabRequests } from './lab-requests';

const row = (
  over: Partial<PatientLabRequestSummaryDto> = {},
): PatientLabRequestSummaryDto =>
  ({
    id: 'lr-1',
    number: 'GVM-REQ-20261104-00012',
    status: 'awaiting_consent',
    priority: 'urgent',
    doctor: { id: 'sp-1', name: 'Dr. Grace Bell', specialty: 'Cardiology' },
    items_count: 2,
    results_count: 0,
    reviewed: false,
    awaiting_review: false,
    appointment_id: null,
    sent_at: '2026-11-04T10:00:00Z',
    valid_until: '2026-12-04',
    expires_at: '2026-12-04T23:00:00Z',
    last_activity_at: '2026-11-04T10:00:00Z',
    ...over,
  }) as PatientLabRequestSummaryDto;

const counts = (
  over: Partial<Record<LabListGroup, number>> = {},
): Record<LabListGroup, number> => ({
  all: 3,
  awaiting_patient: 1,
  in_progress: 1,
  result_ready: 1,
  ...over,
});

const page = (
  data: PatientLabRequestSummaryDto[],
  c = counts(),
  meta: { page?: number; total_pages?: number } = {},
) =>
  of({
    status: 'success',
    message: 'OK',
    data,
    meta: {
      total: data.length,
      page: meta.page ?? 1,
      per_page: 20,
      total_pages: meta.total_pages ?? 1,
      counts: c,
    },
  });

describe('LabRequests (the list)', () => {
  let fixture: ComponentFixture<LabRequests>;
  let el: HTMLElement;
  let mine: ReturnType<typeof vi.fn>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const setup = async (impl: (q: PatientLabListQuery) => unknown) => {
    mine = vi.fn(impl);
    await TestBed.configureTestingModule({
      imports: [LabRequests],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        { provide: LabRequestsApi, useValue: { mine } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(LabRequests);
    el = fixture.nativeElement;
    await settle();
  };
  const filter = (label: string) =>
    Array.from(
      el.querySelectorAll<HTMLButtonElement>('[role="group"] button'),
    ).find((b) => b.textContent?.includes(label)) as HTMLButtonElement;

  afterEach(() => vi.restoreAllMocks());

  it('cards: doctor, number, test count and priority, sent date, chip and helper — never a test name', async () => {
    await setup(() =>
      page([
        row(),
        row({
          id: 'lr-2',
          number: 'GVM-REQ-20261101-00003',
          status: 'result_ready',
          results_count: 1,
          reviewed: true,
          items_count: 1,
          priority: 'stat',
        }),
      ]),
    );
    const cards = el.querySelectorAll<HTMLAnchorElement>(
      'ul[aria-label="Lab requests"] a',
    );
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute('href')).toBe('/dashboard/lab-requests/lr-1');
    const first = cards[0].textContent ?? '';
    expect(first).toContain('Lab request from Dr. Grace Bell');
    expect(first).toContain('GVM-REQ-20261104-00012');
    expect(first).toContain('2 tests · Urgent');
    expect(first).toContain('Sent Wed 4 Nov 2026');
    expect(first).toContain('Action needed');
    expect(first).toContain('Review and accept this request');
    const second = cards[1].textContent ?? '';
    expect(second).toContain('1 test · STAT');
    expect(second).toContain('Reviewed by your doctor');
    expect(second).toContain("Open to read your doctor's note");
    // Rows carry no test names or reasons (the API never sends them; nothing is invented here).
    expect(el.textContent).not.toMatch(/FBC|Full Blood|abnormal/i);
  });

  it('a private-only result reads "Result uploaded" without "Waiting for … to review"', async () => {
    await setup(() =>
      page([
        row({
          status: 'result_ready',
          results_count: 1,
          reviewed: false,
          awaiting_review: false,
        }),
      ]),
    );
    expect(el.textContent).toContain('Result uploaded');
    expect(el.textContent).toContain('Open to see who can review it');
    expect(el.textContent).not.toContain('Waiting for');
  });

  it('filters by group on the server, each with its count; the pressed one says so', async () => {
    await setup((q) =>
      q.group === 'result_ready'
        ? page([
            row({
              id: 'lr-9',
              status: 'result_ready',
              awaiting_review: true,
              results_count: 1,
            }),
          ])
        : page([row()]),
    );
    expect(mine).toHaveBeenLastCalledWith({
      group: 'all',
      page: 1,
      per_page: 20,
    });
    const labels = Array.from(
      el.querySelectorAll(
        '[role="group"][aria-label="Filter by status"] button',
      ),
    ).map((b) => b.textContent?.replace(/\s+/g, ' ').trim());
    expect(labels).toEqual([
      'All (3)',
      'Action needed (1)',
      'In progress (1)',
      'Results (1)',
    ]);
    // On a phone the row wraps instead of hiding filters off to the side.
    const filterRow = el.querySelector(
      '[role="group"][aria-label="Filter by status"]',
    ) as HTMLElement;
    expect(filterRow.classList.contains('flex-wrap')).toBe(true);
    expect(filterRow.classList.contains('overflow-x-auto')).toBe(false);
    expect(filter('All').getAttribute('aria-pressed')).toBe('true');
    filter('Results').click();
    await settle();
    expect(mine).toHaveBeenLastCalledWith({
      group: 'result_ready',
      page: 1,
      per_page: 20,
    });
    expect(filter('Results').getAttribute('aria-pressed')).toBe('true');
    expect(filter('All').getAttribute('aria-pressed')).toBe('false');
    expect(el.textContent).toContain('Waiting for Dr. Grace Bell to review');
  });

  it('empty, empty filter and error states', async () => {
    await setup((q) =>
      q.group === 'in_progress'
        ? page([], counts({ in_progress: 0 }))
        : page(
            [],
            counts({
              all: 0,
              awaiting_patient: 0,
              in_progress: 0,
              result_ready: 0,
            }),
          ),
    );
    expect(el.textContent).toContain('No lab requests yet');
    expect(el.textContent).toContain(
      'When a doctor requests tests or scans for you, they appear here.',
    );
    expect(el.querySelector('[role="group"]')).toBeNull();

    TestBed.resetTestingModule();
    await setup((q) =>
      q.group === 'in_progress'
        ? page([], counts({ in_progress: 0 }))
        : page([row()]),
    );
    filter('In progress').click();
    await settle();
    expect(el.textContent).toContain('Nothing in this filter.');

    TestBed.resetTestingModule();
    await setup(() => throwError(() => ({ statusCode: 500, message: '' })));
    expect(el.textContent).toContain("Couldn't load your lab tests");
    expect(el.textContent).toContain('Try again');
  });

  it('Load more fetches the next page and appends it', async () => {
    await setup((q) =>
      q.page === 2
        ? page([row({ id: 'lr-2', number: 'GVM-REQ-2' })], counts(), {
            page: 2,
            total_pages: 2,
          })
        : page([row()], counts(), { total_pages: 2 }),
    );
    const more = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Load more',
    ) as HTMLButtonElement;
    more.click();
    await settle();
    expect(mine).toHaveBeenLastCalledWith({
      group: 'all',
      page: 2,
      per_page: 20,
    });
    expect(el.querySelectorAll('ul[aria-label="Lab requests"] a')).toHaveLength(
      2,
    );
    expect(
      Array.from(el.querySelectorAll('button')).some(
        (b) => b.textContent?.trim() === 'Load more',
      ),
    ).toBe(false);
  });

  it('shows the history sections with "Lab tests" current', async () => {
    await setup(() => page([row()]));
    const nav = el.querySelector(
      'nav[aria-label="Consultation history sections"]',
    ) as HTMLElement;
    const current = nav.querySelector(
      '[aria-current="page"]',
    ) as HTMLAnchorElement;
    expect(current.textContent?.trim()).toBe('Lab tests');
    expect(current.getAttribute('href')).toBe('/dashboard/lab-requests');
    expect(
      Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href')),
    ).toEqual([
      '/dashboard/history',
      '/dashboard/prescriptions',
      '/dashboard/lab-requests',
    ]);
  });
});
