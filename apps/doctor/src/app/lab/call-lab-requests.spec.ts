import { ApplicationRef, Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { DoctorApi, LabRequestsApi } from '@supadoc/data-access';
import type { LabOrderDto, LabRequestSummaryDto } from '@supadoc/models';
import { DialogService, provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService, type ViewerOpenOptions, type ViewerSource } from '@supadoc/viewer';
import { type Observable, of, Subject, throwError } from 'rxjs';
import { WS_RESULTS_NOT_SHARED } from '../call-workspace/call-workspace-copy';
import { CallLabComposer } from './call-lab-composer';
import { CallLabRequestDetail } from './call-lab-request-detail';
import { CallLabRequests } from './call-lab-requests';
import { UNSAVED_LAB_LEAVE } from './lab-composer';
import { LabFiles } from './lab-files';
import { LAB_RESULT_KEY } from './lab-viewer-sources';
import { labContext, labOptions, labRequest, labSummary, must } from './testing/lab-fixtures';

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

const RESULT = {
  id: 'res1',
  uploaded_at: '2026-11-01T10:00:00Z',
  item_ids: [],
  visible: true,
  reviewable: true,
  document: { title: 'FBC result', type_label: 'Lab report', extension: 'pdf', size_label: '1 MB', viewable: true },
  review: null,
};

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const page = (data: LabRequestSummaryDto[]) => ({
  status: 'success',
  message: 'OK',
  data,
  meta: { total: data.length, page: 1, per_page: 50, total_pages: 1, counts: { all: data.length, awaiting_patient: 0, in_progress: 0, result_ready: 0 } },
});

@Component({
  imports: [CallLabRequests],
  template: `
    <button id="ws-tab-labs" type="button">Lab requests</button>
    <doc-call-lab-requests
      [appointmentId]="aid()"
      [patientId]="pid()"
      [signedIn]="signedIn()"
      [watermark]="watermark()"
      [active]="active()"
      [sharing]="sharing()"
      [composeRequest]="seq()"
      [detailsFailed]="failed()"
      [patientError]="patientError()"
      (retryPatient)="retries = retries + 1"
    />
  `,
})
class Host {
  readonly aid = signal<string | null>('ap-1');
  readonly pid = signal<string | null>('p1');
  readonly signedIn = signal(true);
  readonly watermark = signal<{ viewerName: string; timeZone: string } | null>({ viewerName: 'Dr Ada Obi', timeZone: 'Africa/Lagos' });
  readonly active = signal(true);
  readonly sharing = signal(false);
  readonly seq = signal(0);
  readonly failed = signal(false);
  readonly patientError = signal('');
  retries = 0;
}

// A first test compiles the whole component tree (JIT): beyond the 5 s default on a busy machine.
describe('CallLabRequests (the call’s Lab requests tab)', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;
  let api: {
    list: ReturnType<typeof vi.fn>;
    options: ReturnType<typeof vi.fn>;
    context: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    viewResult: ReturnType<typeof vi.fn>;
    resultPrinted: ReturnType<typeof vi.fn>;
  };
  let listLabOrders: ReturnType<typeof vi.fn>;
  let view: ReturnType<typeof vi.fn>;
  let open: ReturnType<typeof vi.fn>;
  let confirmLeave: ReturnType<typeof vi.spyOn>;
  let windowOpen: ReturnType<typeof vi.spyOn>;

  interface Options {
    readonly rows?: LabRequestSummaryDto[];
    readonly legacy?: LabOrderDto[];
    readonly get?: (id: string) => Observable<unknown>;
    readonly active?: boolean;
  }

  async function setup(o: Options = {}) {
    const rows = o.rows ?? [labSummary({ appointment_id: 'ap-1', status: 'booked' })];
    api = {
      list: vi.fn(() => of(page(rows))),
      options: vi.fn(() => of({ data: labOptions() })),
      context: vi.fn(() => of({ data: labContext({ appointment: { id: 'ap-1', scheduled_at: '2026-11-04T15:00:00Z' } }) })),
      create: vi.fn(() => of({ data: labRequest({ id: 'new1', number: 'GVM-REQ-20261105-00001', sent_at: '2026-11-05T09:30:00Z' }) })),
      get: vi.fn(o.get ?? ((id: string) => of({ data: labRequest({ id, appointment_id: 'ap-1', results: [RESULT as never] }) }))),
      cancel: vi.fn(),
      viewResult: vi.fn(),
      resultPrinted: vi.fn(),
    };
    listLabOrders = vi.fn(() => of({ data: o.legacy ?? [] }));
    view = vi.fn();
    open = vi.fn();
    windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideSupadocIcons(),
        { provide: LabRequestsApi, useValue: api },
        { provide: DoctorApi, useValue: { listLabOrders } },
        { provide: LabFiles, useValue: { view } },
        { provide: DocumentViewerService, useValue: { open } },
      ],
    });
    confirmLeave = vi.spyOn(TestBed.inject(DialogService), 'confirmLeave').mockImplementation(() => Promise.resolve(true));
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    if (o.active === false) host.active.set(false);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await settle();
  }

  async function settle() {
    for (let i = 0; i < 3; i++) {
      fixture.detectChanges();
      TestBed.inject(ApplicationRef).tick();
      await fixture.whenStable();
      await wait();
    }
  }

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  const tab = () => fixture.debugElement.query((d) => d.componentInstance instanceof CallLabRequests).componentInstance as CallLabRequests;
  const composerHost = () => fixture.debugElement.query((d) => d.componentInstance instanceof CallLabComposer)?.componentInstance as CallLabComposer | undefined;
  const text = (node: Element | null = el) => node?.textContent?.replace(/\s+/g, ' ') ?? '';
  const buttonIn = (scope: ParentNode, label: string) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === label) ?? null;
  const button = (label: string) => buttonIn(el, label);
  const newRequest = () => must(el.querySelector<HTMLButtonElement>('#call-lab-new button'), 'New lab request');
  const refreshBtn = () => must(el.querySelector<HTMLButtonElement>('[aria-label="Refresh the lab requests"]'), 'Refresh');
  const dialogEl = (title: string) =>
    must(
      Array.from(document.querySelectorAll('dialog')).find((d) => d.open && d.textContent?.includes(title)),
      `dialog "${title}"`,
    );
  /** The arguments of call `i` of a mock. */
  const args = (fn: { mock: { calls: unknown[] } }, i: number) => fn.mock.calls[i] as unknown[];
  const visible = () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  async function edit(id: string, value: string) {
    const input = document.getElementById(id) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  async function pick(selectId: string, label: string) {
    must(document.getElementById(selectId), selectId).click();
    fixture.detectChanges();
    const opt = Array.from(document.querySelectorAll<HTMLElement>(`#${selectId}-listbox [role="option"]`)).find((x) => x.textContent?.trim() === label);
    must(opt, `option ${label}`).click();
    await settle();
  }

  async function sendOne() {
    await pick('lab-quick', 'FBC');
    await edit('lab-question', 'Suspected iron-deficiency anaemia');
    must(document.getElementById('lab-preview-button'), 'Preview Request').click();
    await settle();
    (document.getElementById('lab-attest') as HTMLInputElement).click();
    await settle();
    must(buttonIn(dialogEl('Preview request'), 'Send to Patient'), 'Send to Patient').click();
    await settle();
  }

  describe('the list', () => {
    it('a header with "New lab request" and Refresh; the rows with View PDF and Open; no link, no new-tab icon', async () => {
      await setup();
      expect(text(el.querySelector('#call-lab-list-title'))).toContain('Lab requests');
      expect(text()).toContain('Requested during this consultation.');
      expect(newRequest().disabled).toBe(false);
      const r = labSummary();
      expect(el.querySelector(`[aria-label="View PDF of ${r.number}"]`)).not.toBeNull();
      const openBtn = must(el.querySelector(`[data-lab-open="${r.id}"]`), 'Open');
      expect(openBtn.getAttribute('aria-label')).toBe(`Open ${r.number}`);
      expect(el.querySelector('a, [routerLink], [href]')).toBeNull();
      expect(el.querySelector('sd-icon[name="external-link"]')).toBeNull();
      expect(text()).not.toContain('new tab');
    });

    it('while the patient is loading, "New lab request" waits', async () => {
      await setup();
      host.pid.set(null);
      await settle();
      expect(text()).toContain('Loading the patient…');
      expect(newRequest().disabled).toBe(true);
    });

    it('the patient not found: the error with Try again (asks the host); details failed: the line', async () => {
      await setup();
      host.patientError.set('Could not find the patient for this consultation.');
      await settle();
      expect(text()).toContain('Could not find the patient for this consultation.');
      must(button('Try again'), 'Try again').click();
      expect(host.retries).toBe(1);
      host.patientError.set('');
      host.failed.set(true);
      await settle();
      expect(text()).toContain("Lab requests are available once this consultation's details have loaded.");
      expect(newRequest().disabled).toBe(true);
    });

    it('empty: the dashed card; legacy orders read-only', async () => {
      await setup({ rows: [], legacy: [ORDER] });
      expect(text()).toContain('No lab requests yet for this consultation');
      expect(text()).toContain('Earlier lab orders');
      expect(text()).toContain('Full blood count, Lipid panel');
    });

    it('the first read and Refresh are active; focus / visibility re-reads are passive', async () => {
      await setup({ legacy: [ORDER] });
      expect(args(api.list, 0)[1]).toBeUndefined();
      expect(args(listLabOrders, 0)[1]).toBeUndefined();
      window.dispatchEvent(new Event('focus'));
      expect(args(api.list, 1)).toEqual([{ appointment_id: 'ap-1', per_page: 50 }, { passive: true }]);
      expect(args(listLabOrders, 1)).toEqual(['ap-1', { passive: true }]);
      visible();
      expect(args(api.list, 2)[1]).toEqual({ passive: true });
      refreshBtn().click();
      expect(args(api.list, 3)[1]).toBeUndefined();
      expect(args(listLabOrders, 3)[1]).toBeUndefined();
    });

    it('rows survive a refresh: no shimmer, every Open stays, Refresh is never disabled; with no rows the shimmer shows', async () => {
      await setup();
      const pending = new Subject<unknown>();
      api.list.mockImplementation(() => pending);
      refreshBtn().focus();
      refreshBtn().click();
      await settle();
      expect(el.querySelector('.sd-shimmer')).toBeNull();
      expect(el.querySelectorAll('[data-lab-open]').length).toBe(1);
      expect(refreshBtn().disabled).toBe(false);
      expect(refreshBtn().getAttribute('aria-busy')).toBe('true');
      expect(document.activeElement).toBe(refreshBtn());
      pending.next(page([labSummary()]));
      pending.complete();
      await settle();
      expect(document.activeElement).toBe(refreshBtn());
      fixture.destroy();
      el.remove();
      TestBed.resetTestingModule();
      vi.restoreAllMocks();
      const never = new Subject<unknown>();
      await setup({ rows: [] });
      api.list.mockImplementation(() => never);
      refreshBtn().click();
      await settle();
      expect(el.querySelector('[aria-busy="true"] .sd-shimmer')).not.toBeNull();
    });

    it('sharing: a result-ready abnormal request reads "Result ready", otherwise "Result ready · Abnormal"', async () => {
      await setup({ rows: [labSummary({ appointment_id: 'ap-1', status: 'result_ready', abnormal: true })] });
      expect(text()).toContain('Result ready · Abnormal');
      host.sharing.set(true);
      await settle();
      expect(text()).not.toContain('Abnormal');
      expect(text()).toContain('Result ready');
    });

    it('signed out: nothing is read, the list is cleared', async () => {
      await setup();
      host.signedIn.set(false);
      await settle();
      expect(el.querySelectorAll('[data-lab-open]').length).toBe(0);
      api.list.mockClear();
      window.dispatchEvent(new Event('focus'));
      expect(api.list).not.toHaveBeenCalled();
    });
  });

  describe('"New lab request": the composer in place', () => {
    it('replaces the list in this tab, focus on its title; never window.open', async () => {
      await setup();
      newRequest().click();
      await settle();
      expect(el.querySelector('doc-call-lab-composer')).not.toBeNull();
      expect(el.querySelector('#call-lab-list-title')).toBeNull();
      expect(document.activeElement?.id).toBe('call-lab-compose-title');
      expect(windowOpen).not.toHaveBeenCalled();
      expect(api.context).toHaveBeenCalledWith('p1', 'ap-1');
    });

    it('unsent: false in the list, true after an edit, false after Cancel and the prompt; a clean Cancel asks nothing', async () => {
      await setup();
      expect(tab().unsent()).toBe(false);
      newRequest().click();
      await settle();
      expect(tab().unsent()).toBe(false);
      must(button('Cancel'), 'Cancel').click();
      await settle();
      expect(confirmLeave).not.toHaveBeenCalled();
      expect(el.querySelector('doc-call-lab-composer')).toBeNull();
      expect(document.activeElement).toBe(newRequest());
      newRequest().click();
      await settle();
      await edit('lab-question', 'Fatigue');
      expect(tab().unsent()).toBe(true);
      must(button('Cancel'), 'Cancel').click();
      await settle();
      expect(confirmLeave).toHaveBeenCalledTimes(1);
      expect(confirmLeave).toHaveBeenCalledWith(UNSAVED_LAB_LEAVE);
      expect(tab().unsent()).toBe(false);
      expect(el.querySelector('#call-lab-list-title')).not.toBeNull();
    });

    it('sent → "Back to lab requests": the list, one new active read, the notice focused', async () => {
      await setup();
      newRequest().click();
      await settle();
      await sendOne();
      const sent = dialogEl('Request Sent');
      expect(buttonIn(sent, 'Back to lab requests')).not.toBeNull();
      api.list.mockClear();
      must(buttonIn(sent, 'Back to lab requests'), 'back').click();
      await settle();
      expect(api.list).toHaveBeenCalledTimes(1);
      expect(args(api.list, 0)[1]).toBeUndefined();
      const notice = must(el.querySelector('sd-alert[tabindex="-1"]'), 'notice');
      expect(text(notice)).toContain('GVM-REQ-20261105-00001 sent — the patient has been notified.');
      expect(document.activeElement).toBe(notice);
      expect(tab().unsent()).toBe(false);
    });

    it('"+ New Request": options and context read again, an empty form for the same patient and consultation', async () => {
      await setup();
      newRequest().click();
      await settle();
      await sendOne();
      must(buttonIn(dialogEl('Request Sent'), '+ New Request'), '+ New Request').click();
      await settle();
      expect(api.options).toHaveBeenCalledTimes(2);
      expect(api.context).toHaveBeenCalledTimes(2);
      expect(args(api.context, 1)).toEqual(['p1', 'ap-1']);
      expect((document.getElementById('lab-question') as HTMLInputElement).value).toBe('');
      expect(tab().composing()).toBe(true);
    });

    it('no reads while composing (focus, visibility, active); each return to the list reads once, actively', async () => {
      await setup();
      newRequest().click();
      await settle();
      api.list.mockClear();
      window.dispatchEvent(new Event('focus'));
      visible();
      host.active.set(false);
      await settle();
      host.active.set(true);
      await settle();
      expect(api.list).not.toHaveBeenCalled();
      must(button('Cancel'), 'Cancel').click();
      await settle();
      expect(api.list).toHaveBeenCalledTimes(1);
      expect(args(api.list, 0)[1]).toBeUndefined();
    });
  });

  describe('composeRequest (the Full EMR’s "New lab request")', () => {
    it('bumped before the first render and after: the composer opens once per bump', async () => {
      await setup();
      host.seq.set(1);
      await settle();
      expect(tab().composing()).toBe(true);
      must(button('Cancel'), 'Cancel').click();
      await settle();
      expect(tab().composing()).toBe(false);
      host.seq.set(2);
      await settle();
      expect(tab().composing()).toBe(true);
    });

    it('while a request is being written: the same composer, its values kept, focus untouched', async () => {
      await setup();
      newRequest().click();
      await settle();
      await edit('lab-question', 'Fatigue');
      const instance = composerHost();
      const field = document.getElementById('lab-question') as HTMLInputElement;
      field.focus();
      host.seq.set(1);
      await settle();
      expect(composerHost()).toBe(instance);
      expect((document.getElementById('lab-question') as HTMLInputElement).value).toBe('Fatigue');
      expect(document.activeElement).toBe(field);
    });

    it('signed out: consumed, and signing in later opens nothing', async () => {
      await setup();
      host.signedIn.set(false);
      await settle();
      host.seq.set(1);
      await settle();
      expect(tab().composing()).toBe(false);
      host.signedIn.set(true);
      await settle();
      expect(tab().composing()).toBe(false);
      expect(el.querySelector('doc-call-lab-composer')).toBeNull();
    });
  });

  describe('signing out', () => {
    it('while composing: the same composer stays (disabled, with its line), nothing is read; signed in again, enabled with the values', async () => {
      await setup();
      newRequest().click();
      await settle();
      await edit('lab-question', 'Fatigue');
      const instance = composerHost();
      api.list.mockClear();
      host.signedIn.set(false);
      await settle();
      expect(composerHost()).toBe(instance);
      const preview = must(document.getElementById('lab-preview-button'), 'Preview Request');
      expect(preview.getAttribute('aria-disabled')).toBe('true');
      expect(document.getElementById('lab-signed-out-note')).not.toBeNull();
      expect(api.list).not.toHaveBeenCalled();
      host.signedIn.set(true);
      await settle();
      expect(composerHost()).toBe(instance);
      expect((document.getElementById('lab-question') as HTMLInputElement).value).toBe('Fatigue');
      expect(document.getElementById('lab-signed-out-note')).toBeNull();
    });

    it('signed out while composing, Back (clean form): the list, focus on the Lab requests tab', async () => {
      await setup();
      newRequest().click();
      await settle();
      host.signedIn.set(false);
      await settle();
      must(el.querySelector<HTMLButtonElement>('[aria-label="Back to lab requests"]'), 'Back').click();
      await settle();
      expect(tab().view()).toBe('list');
      expect(document.activeElement?.id).toBe('ws-tab-labs');
    });

    it('in the drill-in: back to the list, the drill-in destroyed', async () => {
      await setup();
      must(el.querySelector<HTMLButtonElement>('[data-lab-open]'), 'Open').click();
      await settle();
      expect(el.querySelector('doc-call-lab-request-detail')).not.toBeNull();
      host.signedIn.set(false);
      await settle();
      expect(el.querySelector('doc-call-lab-request-detail')).toBeNull();
      expect(tab().view()).toBe('list');
    });

    it('with the Sent dialog open: it closes into the list, no notice, focus on the Lab requests tab', async () => {
      await setup();
      newRequest().click();
      await settle();
      await sendOne();
      dialogEl('Request Sent');
      host.signedIn.set(false);
      await settle();
      expect(tab().view()).toBe('list');
      expect(Array.from(document.querySelectorAll('dialog')).some((d) => d.open && d.textContent?.includes('Request Sent'))).toBe(false);
      expect(el.querySelector('sd-alert[tabindex="-1"]')).toBeNull();
      expect(document.activeElement?.id).toBe('ws-tab-labs');
    });
  });

  describe('"Open": the drill-in', () => {
    it('in place, focus on its title; Back → the list, focus on that row’s Open; never window.open', async () => {
      await setup();
      const id = labSummary().id;
      must(el.querySelector<HTMLButtonElement>(`[data-lab-open="${id}"]`), 'Open').click();
      await settle();
      const detail = fixture.debugElement.query((d) => d.componentInstance instanceof CallLabRequestDetail).componentInstance as CallLabRequestDetail;
      expect(detail.labId()).toBe(id);
      expect(el.querySelector('#call-lab-list-title')).toBeNull();
      expect(document.activeElement?.id).toBe('call-lab-detail-title');
      api.list.mockClear();
      window.dispatchEvent(new Event('focus'));
      expect(api.list).not.toHaveBeenCalled();
      must(el.querySelector<HTMLButtonElement>('[aria-label="Back to lab requests"]'), 'Back').click();
      await settle();
      expect(api.list).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(el.querySelector(`[data-lab-open="${id}"]`));
      expect(windowOpen).not.toHaveBeenCalled();
    });

    it('Duplicate: the composer, pre-filled from the request', async () => {
      await setup();
      must(el.querySelector<HTMLButtonElement>('[data-lab-open]'), 'Open').click();
      await settle();
      must(button('Duplicate'), 'Duplicate').click();
      await settle();
      expect(tab().composing()).toBe(true);
      expect((document.getElementById('lab-question') as HTMLInputElement).value).toBe('Suspected iron-deficiency anaemia');
      expect(document.activeElement?.id).toBe('call-lab-compose-title');
    });
  });

  describe('documents', () => {
    it('View PDF opens the request in the viewer, focus coming back to its button', async () => {
      await setup();
      const b = must(el.querySelector<HTMLButtonElement>(`[aria-label="View PDF of ${labSummary().number}"]`), 'View PDF');
      b.click();
      expect(view).toHaveBeenCalledTimes(1);
      expect(view.mock.calls[0]?.[0]).toMatchObject({ id: labSummary().id, number: labSummary().number });
      expect(view.mock.calls[0]?.[1]).toBe(b);
    });

    it('Results (n): only with results and a watermark; opens them view-only, watermarked, focus falling back to the list title', async () => {
      await setup({ rows: [labSummary({ appointment_id: 'ap-1', status: 'result_ready', results_count: 1 })] });
      const b = must(button('Results (1)'), 'Results');
      b.click();
      expect(api.get).toHaveBeenCalledWith(labSummary().id);
      expect(open).toHaveBeenCalledTimes(1);
      const [sources, options] = open.mock.calls[0] as [ViewerSource[], ViewerOpenOptions];
      expect(sources.map((s) => s.key)).toEqual([LAB_RESULT_KEY + 'res1']);
      expect(sources[0]?.policy).toBe('view_only');
      expect(sources[0]?.download).toBeUndefined();
      expect(options.watermark).toEqual({ viewerName: 'Dr Ada Obi', timeZone: 'Africa/Lagos' });
      expect(options.listLabel).toBe('results');
      expect(options.opener).toBe(b);
      expect(options.fallbackFocus?.()?.id).toBe('call-lab-list-title');
      host.watermark.set(null);
      await settle();
      expect(button('Results (1)')).toBeNull();
    });

    it('Results with none openable: says they are not shared; failing: the error inline', async () => {
      await setup({
        rows: [labSummary({ appointment_id: 'ap-1', status: 'result_ready', results_count: 1 })],
        get: () => of({ data: { results: [{ ...RESULT, visible: false, document: null }] } }),
      });
      must(button('Results (1)'), 'Results').click();
      await settle();
      expect(open).not.toHaveBeenCalled();
      expect(el.querySelector('li [role="status"]')?.textContent).toContain(WS_RESULTS_NOT_SHARED);
      api.get.mockImplementation(() => throwError(() => ({ status: 500, message: 'Nope' })));
      must(button('Results (1)'), 'Results').click();
      await settle();
      expect((el.querySelector('li [role="status"]')?.textContent ?? '').length).toBeGreaterThan(0);
    });

    it('a Results read still out never opens the viewer once the tab stops showing', async () => {
      const answer = new Subject<unknown>();
      await setup({ rows: [labSummary({ appointment_id: 'ap-1', status: 'result_ready', results_count: 1 })], get: () => answer });
      must(button('Results (1)'), 'Results').click();
      await settle();
      expect(must(button('Opening…'), 'Opening').disabled).toBe(true);
      host.active.set(false);
      await settle();
      expect(answer.observed).toBe(false);
      answer.next({ data: { results: [RESULT] } });
      expect(open).not.toHaveBeenCalled();
      expect(must(button('Results (1)'), 'Results').disabled).toBe(false);
    });
  });

  describe('active', () => {
    it('false: no read on init, on focus or on visibility; turning true: an active pair each time; focus then: a passive pair', async () => {
      await setup({ active: false });
      window.dispatchEvent(new Event('focus'));
      visible();
      expect(api.list).not.toHaveBeenCalled();
      expect(listLabOrders).not.toHaveBeenCalled();
      host.active.set(true);
      await settle();
      expect(api.list).toHaveBeenCalledTimes(1);
      expect(args(api.list, 0)[1]).toBeUndefined();
      host.active.set(false);
      await settle();
      window.dispatchEvent(new Event('focus'));
      expect(api.list).toHaveBeenCalledTimes(1);
      host.active.set(true);
      await settle();
      expect(api.list).toHaveBeenCalledTimes(2);
      window.dispatchEvent(new Event('focus'));
      expect(api.list).toHaveBeenCalledTimes(3);
      expect(args(api.list, 2)[1]).toEqual({ passive: true });
      expect(args(listLabOrders, 2)[1]).toEqual({ passive: true });
    });
  });
});
