import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DoctorApi, LabRequestsApi } from '@supadoc/data-access';
import type { LabOrderDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService, type ViewerOpenOptions, type ViewerSource } from '@supadoc/viewer';
import { Observable, of, Subject, throwError } from 'rxjs';
import { WS_RESULTS_NOT_SHARED } from '../call-workspace/call-workspace-copy';
import { CALL_LAB_CAPTION, CALL_LAB_CAPTION_NARROW, CallLabRequests } from './call-lab-requests';
import { LabFiles } from './lab-files';
import { LAB_RESULT_KEY } from './lab-viewer-sources';
import { labSummary, must } from './testing/lab-fixtures';

const ORDER: LabOrderDto = {
  id: 'o1',
  appointment_id: 'ap-1',
  tests: ['Full blood count', 'Lipid panel'],
  instructions: null,
  priority: 'urgent',
  status: 'ordered',
  author: 'Dr. James Smith',
  created_at: '2026-10-01T10:00:00Z',
};

function apis(legacy: LabOrderDto[] = []) {
  const list = vi.fn(() =>
    of({
      status: 'success',
      message: 'OK',
      data: [labSummary({ appointment_id: 'ap-1', status: 'booked' })],
      meta: { total: 1, page: 1, per_page: 50, total_pages: 1, counts: { all: 1, awaiting_patient: 0, in_progress: 1, result_ready: 0 } },
    }),
  );
  const listLabOrders = vi.fn(() => of({ data: legacy }));
  return { list, listLabOrders };
}

describe('CallLabRequests (in-call tab)', () => {
  @Component({
    imports: [CallLabRequests],
    template: `<doc-call-lab-requests [appointmentId]="aid()" [patientId]="pid()" [signedIn]="signedIn()" [narrow]="narrow()" tone="dark" />`,
  })
  class Host {
    readonly aid = signal<string | null>('ap-1');
    readonly pid = signal<string | null>('p 1');
    readonly signedIn = signal(true);
    readonly narrow = signal(false);
  }

  function setup(legacy: LabOrderDto[] = []) {
    const a = apis(legacy);
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideSupadocIcons(),
        { provide: LabRequestsApi, useValue: { list: a.list } },
        { provide: DoctorApi, useValue: { listLabOrders: a.listLabOrders } },
        { provide: DocumentViewerService, useValue: { open: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return { fixture, host: fixture.componentInstance, el: fixture.nativeElement as HTMLElement, ...a };
  }

  afterEach(() => vi.restoreAllMocks());

  it('"New lab request" opens the composer in a new tab (same-origin path, noopener); the call tab stays', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { el } = setup();
    const btn = must(Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('New lab request')), 'element');
    btn.click();
    expect(open).toHaveBeenCalledWith('/prescriptions/labs/new?patientId=p%201&appointmentId=ap-1', '_blank', 'noopener');
    must(Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Open'), 'element').click();
    expect(open).toHaveBeenLastCalledWith('/prescriptions/labs/lr1', '_blank', 'noopener');
  });

  it('the caption warns about a paused video only in the narrow layout', () => {
    const { el, fixture, host } = setup();
    expect(el.textContent).toContain(CALL_LAB_CAPTION);
    expect(el.textContent).not.toContain('video may pause');
    host.narrow.set(true);
    fixture.detectChanges();
    expect(el.textContent).toContain(CALL_LAB_CAPTION_NARROW);
  });

  it('while the patient is loading the button waits', () => {
    const { el, fixture, host } = setup();
    host.pid.set(null);
    fixture.detectChanges();
    expect(el.textContent).toContain('Loading the patient…');
    expect(must(Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('New lab request')), 'element').disabled).toBe(true);
  });

  it('signed out: asks to sign in, loads nothing', () => {
    const { el, fixture, host, list } = setup();
    host.signedIn.set(false);
    fixture.detectChanges();
    expect(el.textContent).toContain('Sign in to the doctor portal to request tests.');
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent?.includes('New lab request'))).toBe(false);
    list.mockClear();
    window.dispatchEvent(new Event('focus'));
    expect(list).not.toHaveBeenCalled();
  });

  it('refreshes when the doctor comes back to this tab, and on Refresh; lists legacy orders read-only', () => {
    const { el, list } = setup([ORDER]);
    expect(list).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('focus'));
    expect(list).toHaveBeenCalledTimes(2);
    must(Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Refresh'), 'Refresh').click();
    expect(list).toHaveBeenCalledTimes(3);
    expect(el.textContent).toContain('Earlier lab orders');
    expect(el.textContent).toContain('Full blood count, Lipid panel');
  });

  it('the re-reads on returning to the window or tab are passive; the first load and Refresh are not', () => {
    const { el, list, listLabOrders } = setup([ORDER]);
    /** The arguments of call `i` of a mock. */
    const args = (fn: { mock: { calls: unknown[] } }, i: number) => fn.mock.calls[i] as unknown[];
    // The first load (the tab opened / signed in) counts as activity.
    expect(args(list, 0)[1]).toBeUndefined();
    expect(args(listLabOrders, 0)[1]).toBeUndefined();

    window.dispatchEvent(new Event('focus'));
    expect(args(list, 1)).toEqual([{ appointment_id: 'ap-1', per_page: 50 }, { passive: true }]);
    expect(args(listLabOrders, 1)).toEqual(['ap-1', { passive: true }]);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
    expect(args(list, 2)[1]).toEqual({ passive: true });
    expect(args(listLabOrders, 2)[1]).toEqual({ passive: true });

    must(Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Refresh'), 'Refresh').click();
    expect(args(list, 3)[1]).toBeUndefined();
    expect(args(listLabOrders, 3)[1]).toBeUndefined();
  });
});

describe('CallLabRequests: documents and when it reads', () => {
  @Component({
    imports: [CallLabRequests],
    template: `<doc-call-lab-requests appointmentId="ap-1" patientId="p1" [signedIn]="signedIn()" [watermark]="watermark()" [active]="active()" />`,
  })
  class Host {
    readonly watermark = signal<{ viewerName: string; timeZone: string } | null>({ viewerName: 'Dr Ada Obi', timeZone: 'Africa/Lagos' });
    readonly active = signal(true);
    readonly signedIn = signal(true);
  }

  const RESULT = {
    id: 'res1',
    uploaded_at: '2026-11-01T10:00:00Z',
    item_ids: [],
    visible: true,
    reviewable: true,
    document: { title: 'FBC result', type_label: 'Lab report', extension: 'pdf', size_label: '1 MB', viewable: true },
    review: null,
  };

  function setup(options: { readonly results_count?: number; readonly get?: () => Observable<unknown>; readonly active?: boolean } = {}) {
    const a = {
      list: vi.fn(() =>
        of({
          status: 'success',
          message: 'OK',
          data: [labSummary({ appointment_id: 'ap-1', status: 'result_ready', results_count: options.results_count ?? 0 })],
          meta: { total: 1, page: 1, per_page: 50, total_pages: 1, counts: { all: 1, awaiting_patient: 0, in_progress: 0, result_ready: 1 } },
        }),
      ),
      listLabOrders: vi.fn(() => of({ data: [] })),
      get: vi.fn(options.get ?? (() => of({ data: { results: [RESULT] } }))),
    };
    const view = vi.fn();
    const open = vi.fn();
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideSupadocIcons(),
        { provide: LabRequestsApi, useValue: { list: a.list, get: a.get, viewResult: vi.fn(), resultPrinted: vi.fn() } },
        { provide: DoctorApi, useValue: { listLabOrders: a.listLabOrders } },
        { provide: LabFiles, useValue: { view } },
        { provide: DocumentViewerService, useValue: { open } },
      ],
    });
    const fixture = TestBed.createComponent(Host);
    if (options.active === false) fixture.componentInstance.active.set(false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) => Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) ?? null;
    return { fixture, host: fixture.componentInstance, el, button, view, open, ...a };
  }

  afterEach(() => vi.restoreAllMocks());

  it('View PDF opens the request in the viewer, focus coming back to its button', () => {
    const { button, view } = setup();
    const b = button('View PDF');
    expect(b?.getAttribute('aria-label')).toBe('View PDF of ' + labSummary().number);
    b?.click();
    expect(view).toHaveBeenCalledTimes(1);
    expect(view.mock.calls[0]?.[0]).toMatchObject({ id: labSummary().id, number: labSummary().number });
    expect(view.mock.calls[0]?.[1]).toBe(b);
  });

  it('Results (n): only with results and a watermark', () => {
    let t = setup();
    expect(t.button('Results (')).toBeNull();
    t.fixture.destroy();
    TestBed.resetTestingModule();
    t = setup({ results_count: 2 });
    expect(t.button('Results (2)')).not.toBeNull();
    t.host.watermark.set(null);
    t.fixture.detectChanges();
    expect(t.button('Results (')).toBeNull();
  });

  it('Results: reads the request, opens its results view-only, watermarked, focus falling back to the list line', () => {
    const { button, get, open, el } = setup({ results_count: 1 });
    const b = button('Results (1)');
    b?.click();
    expect(get).toHaveBeenCalledWith(labSummary().id);
    expect(open).toHaveBeenCalledTimes(1);
    const [sources, options] = open.mock.calls[0] as [ViewerSource[], ViewerOpenOptions];
    expect(sources.map((s) => s.key)).toEqual([LAB_RESULT_KEY + 'res1']);
    expect(sources[0]?.policy).toBe('view_only');
    expect(sources[0]?.download).toBeUndefined();
    expect(options.watermark).toEqual({ viewerName: 'Dr Ada Obi', timeZone: 'Africa/Lagos' });
    expect(options.listLabel).toBe('results');
    expect(options.opener).toBe(b);
    const fallback = options.fallbackFocus?.();
    expect(fallback?.textContent).toBe('From this consultation');
    expect(fallback?.getAttribute('tabindex')).toBe('-1');
    expect(el.contains(fallback ?? null)).toBe(true);
  });

  it('Results with none openable: says they are not shared, opens nothing', () => {
    const { button, open, el, fixture } = setup({
      results_count: 1,
      get: () => of({ data: { results: [{ ...RESULT, visible: false, document: null }] } }),
    });
    button('Results (1)')?.click();
    fixture.detectChanges();
    expect(open).not.toHaveBeenCalled();
    expect(el.querySelector('[role="status"]')?.textContent).toContain(WS_RESULTS_NOT_SHARED);
  });

  it('Results failing: the error inline', () => {
    const { button, open, el, fixture } = setup({
      results_count: 1,
      get: () => throwError(() => ({ status: 500, message: 'Nope' })),
    });
    button('Results (1)')?.click();
    fixture.detectChanges();
    expect(open).not.toHaveBeenCalled();
    expect((el.querySelector('[role="status"]')?.textContent ?? '').length).toBeGreaterThan(0);
  });

  describe('a Results read still out never opens the viewer later', () => {
    const answerLate = (answer: Subject<unknown>) => answer.next({ data: { results: [RESULT] } });

    it('the tab no longer showing (Esc, another tab): cancelled, the button usable again', () => {
      const answer = new Subject<unknown>();
      const { button, host, fixture, open } = setup({ results_count: 1, get: () => answer });
      button('Results (1)')?.click();
      fixture.detectChanges();
      expect(button('Opening…')?.disabled).toBe(true);
      host.active.set(false);
      fixture.detectChanges();
      expect(answer.observed).toBe(false);
      answerLate(answer);
      fixture.detectChanges();
      expect(open).not.toHaveBeenCalled();
      expect(button('Results (1)')?.disabled).toBe(false);
    });

    it('signing out: cancelled; signed in again, nothing pops up and the row is usable', () => {
      const answer = new Subject<unknown>();
      const { button, host, fixture, open } = setup({ results_count: 1, get: () => answer });
      button('Results (1)')?.click();
      fixture.detectChanges();
      host.signedIn.set(false);
      fixture.detectChanges();
      expect(answer.observed).toBe(false);
      answerLate(answer);
      fixture.detectChanges();
      expect(open).not.toHaveBeenCalled();
      host.signedIn.set(true);
      fixture.detectChanges();
      expect(open).not.toHaveBeenCalled();
      expect(button('Results (1)')?.disabled).toBe(false);
    });

    it('still on screen: the answer opens the viewer, as before', () => {
      const answer = new Subject<unknown>();
      const { button, fixture, open } = setup({ results_count: 1, get: () => answer });
      button('Results (1)')?.click();
      fixture.detectChanges();
      answerLate(answer);
      fixture.detectChanges();
      expect(open).toHaveBeenCalledTimes(1);
    });
  });

  describe('active', () => {
    const visible = () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      try {
        document.dispatchEvent(new Event('visibilitychange'));
      } finally {
        Reflect.deleteProperty(document, 'visibilityState');
      }
    };
    /** The arguments of call `i` of a mock. */
    const args = (fn: { mock: { calls: unknown[] } }, i: number) => fn.mock.calls[i] as unknown[];

    it('false: no read on init, on focus or on visibility', () => {
      const { list, listLabOrders } = setup({ active: false });
      window.dispatchEvent(new Event('focus'));
      visible();
      expect(list).not.toHaveBeenCalled();
      expect(listLabOrders).not.toHaveBeenCalled();
    });

    it('turning true: a non-passive pair, each time; focus while true: a passive pair', () => {
      const { list, listLabOrders, host, fixture } = setup({ active: false });
      host.active.set(true);
      fixture.detectChanges();
      expect(list).toHaveBeenCalledTimes(1);
      expect(listLabOrders).toHaveBeenCalledTimes(1);
      expect(args(list, 0)[1]).toBeUndefined();
      host.active.set(false);
      fixture.detectChanges();
      expect(list).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event('focus'));
      expect(list).toHaveBeenCalledTimes(1);
      host.active.set(true);
      fixture.detectChanges();
      expect(list).toHaveBeenCalledTimes(2);
      expect(args(list, 1)[1]).toBeUndefined();
      window.dispatchEvent(new Event('focus'));
      expect(list).toHaveBeenCalledTimes(3);
      expect(args(list, 2)[1]).toEqual({ passive: true });
      expect(args(listLabOrders, 2)[1]).toEqual({ passive: true });
    });
  });
});
