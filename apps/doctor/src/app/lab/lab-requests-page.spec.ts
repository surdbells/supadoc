import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LabRequestsApi } from '@supadoc/data-access';
import type { LabListGroup, LabRequestSummaryDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { type Observable, of, throwError } from 'rxjs';
import { LabRequestsPage } from './lab-requests-page';
import { labSummary, must } from './testing/lab-fixtures';

type ListArgs = { group?: LabListGroup; q?: string; page?: number; per_page?: number };

function page(rows: LabRequestSummaryDto[], counts = { all: 5, awaiting_patient: 1, in_progress: 2, result_ready: 2 }) {
  return { status: 'success', message: 'OK', data: rows, meta: { total: rows.length, page: 1, per_page: 20, total_pages: 1, counts } };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('LabRequestsPage', () => {
  let list: ReturnType<typeof vi.fn<(q: ListArgs) => Observable<unknown>>>;
  let el: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<LabRequestsPage>>;

  async function setup(answer: (q: ListArgs) => Observable<unknown>) {
    list = vi.fn(answer);
    TestBed.configureTestingModule({
      imports: [LabRequestsPage],
      providers: [provideRouter([]), provideSupadocIcons(), { provide: LabRequestsApi, useValue: { list } }],
    });
    fixture = TestBed.createComponent(LabRequestsPage);
    el = fixture.nativeElement;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const text = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const cards = () => Array.from(el.querySelectorAll<HTMLAnchorElement>('ul a[href^="/prescriptions/labs/"]'));

  it('shows the tab header, then each request as a card: name, age · sex, priority, number · question · tests, chip', async () => {
    await setup(() => of(page([labSummary({ status: 'in_lab', priority: 'stat' })])));
    expect(list).toHaveBeenCalledWith({ group: 'all', q: undefined, page: 1, per_page: 20 });
    expect(el.querySelector('h1')?.textContent).toContain('Prescriptions & Lab');
    expect(el.querySelector('nav [aria-current="page"]')?.textContent?.trim()).toBe('Laboratory & Diagnostics');
    expect(cards().length).toBe(1);
    const card = cards()[0];
    expect(card.getAttribute('href')).toBe('/prescriptions/labs/lr1');
    expect(card.textContent).toContain('Tunde Bakare');
    expect(card.textContent).toContain('55 years · Male');
    expect(card.textContent).toContain('STAT');
    expect(card.textContent?.replace(/\s+/g, ' ')).toContain('GVM-REQ-20261104-00012 · Chest pain, rule out ACS · Troponin I, ECG (12-lead)');
    expect(card.textContent).toContain('In Lab');
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('1 request');
  });

  it('"Needs review" shows when there are reviewable unreviewed results (any status), not at 0', async () => {
    await setup(() =>
      of(
        page([
          labSummary({ id: 'a', status: 'result_ready', unreviewed_count: 1 }),
          labSummary({ id: 'b', status: 'cancelled', unreviewed_count: 2 }),
          labSummary({ id: 'c', status: 'result_ready', unreviewed_count: 0, abnormal: true }),
          labSummary({ id: 'd', status: 'cancelled', abnormal: true }),
        ]),
      ),
    );
    const [a, b, c, d] = cards();
    expect(a.textContent).toContain('Needs review');
    expect(b.textContent).toContain('Needs review');
    expect(c.textContent).not.toContain('Needs review');
    expect(c.textContent).toContain('Result ready · Abnormal');
    expect(d.textContent).toContain('Cancelled');
    expect(d.textContent).toContain('Abnormal result');
  });

  it('the divider before age · sex is drawn by that group (clipped when it wraps), and the status chip never wraps', async () => {
    await setup(() =>
      of(
        page([
          labSummary({ id: 'a', status: 'result_ready', abnormal: true }),
          labSummary({ id: 'b', patient: { id: 'p2', name: 'Ada Obi', age: null, sex: null } }),
        ]),
      ),
    );
    const [a, b] = cards();
    // No free-standing divider element that could be left dangling at the end of a line.
    expect(a.querySelector('[aria-hidden="true"].w-px')).toBeNull();
    const sep = must(a.querySelector('.lr-sep'), '.lr-sep');
    expect(Array.from(sep.children, (c) => c.textContent?.trim())).toEqual(['55 years · Male', 'Routine']);
    expect(sep.closest('.overflow-hidden')).not.toBeNull();
    expect(must(sep.parentElement, 'row').classList.contains('lr-row')).toBe(true);
    // Without age or sex there is nothing to divide: no group, no negative offset.
    expect(b.querySelector('.lr-sep')).toBeNull();
    expect(b.querySelector('.lr-row')).toBeNull();
    const chip = must(Array.from(a.querySelectorAll('span')).find((x) => x.textContent?.trim() === 'Result ready · Abnormal'), 'chip');
    expect(chip.classList.contains('whitespace-nowrap')).toBe(true);
  });

  it('the status filter reloads the group and shows its count badge', async () => {
    await setup((q) => of(page(q.group === 'in_progress' ? [labSummary({ status: 'booked' })] : [labSummary()])));
    const filter = must(el.querySelector<HTMLElement>('#lab-status-filter'), '#lab-status-filter');
    expect(filter.getAttribute('aria-label')).toBe('Status filter: All');
    filter.click();
    fixture.detectChanges();
    const opt = must(
      Array.from(el.querySelectorAll<HTMLElement>('#lab-status-filter-listbox [role="option"]')).find((o) => o.textContent?.trim() === 'In progress'),
      'In progress',
    );
    opt.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(list).toHaveBeenLastCalledWith({ group: 'in_progress', q: undefined, page: 1, per_page: 20 });
    expect(filter.getAttribute('aria-label')).toBe('Status filter: In progress');
    expect(filter.textContent).toContain('2'); // meta.counts.in_progress
  });

  it('search is debounced and sends q', async () => {
    await setup(() => of(page([labSummary()])));
    const input = must(el.querySelector<HTMLInputElement>('input[type="search"]'), 'input[type="search"]');
    expect(input.getAttribute('aria-label')).toBe('Search lab requests');
    expect(input.placeholder).toBe('Search patient, request ID, test...');
    input.value = 'Tunde';
    input.dispatchEvent(new Event('input'));
    expect(list).toHaveBeenCalledTimes(1);
    await wait(350);
    expect(list).toHaveBeenLastCalledWith({ group: 'all', q: 'Tunde', page: 1, per_page: 20 });
  });

  it('empty: "No investigation requests yet" with New Request', async () => {
    await setup(() => of(page([], { all: 0, awaiting_patient: 0, in_progress: 0, result_ready: 0 })));
    expect(text()).toContain('No investigation requests yet');
    const links = Array.from(el.querySelectorAll('a[href="/prescriptions/labs/new"]'));
    expect(links.length).toBe(2);
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('0 requests');
  });

  it('no match for a search, or nothing in a filter', async () => {
    await setup(() => of(page([])));
    const input = must(el.querySelector<HTMLInputElement>('input[type="search"]'), 'input[type="search"]');
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    await wait(350);
    fixture.detectChanges();
    expect(text()).toContain('No requests match “zzz”.');
  });

  it('nothing in a filter (no search) says so', async () => {
    await setup((q) => of(page(q.group === 'all' ? [labSummary()] : [])));
    must(el.querySelector<HTMLElement>('#lab-status-filter'), '#lab-status-filter').click();
    fixture.detectChanges();
    must(
      Array.from(el.querySelectorAll<HTMLElement>('#lab-status-filter-listbox [role="option"]')).find((o) => o.textContent?.trim() === 'Result ready'),
      'Result ready',
    ).click();
    fixture.detectChanges();
    expect(text()).toContain('No requests in this filter.');
    expect(text()).not.toContain('No investigation requests yet');
  });

  it('a load error offers Try again', async () => {
    let fail = true;
    await setup(() => (fail ? throwError(() => ({ statusCode: 500 })) : of(page([labSummary()]))));
    expect(text()).toContain('Could not load your lab requests. Please try again.');
    fail = false;
    must(Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Try again')), 'element').click();
    fixture.detectChanges();
    expect(cards().length).toBe(1);
  });
});
