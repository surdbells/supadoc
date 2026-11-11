import { ApplicationRef, Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { LabRequestsApi } from '@supadoc/data-access';
import type { DoctorLabResultDto, LabRequestDto } from '@supadoc/models';
import { type ConfirmOptions, DialogService, provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService, type ViewerOpenOptions, type ViewerSource } from '@supadoc/viewer';
import { firstValueFrom, isObservable, type Observable, of, throwError } from 'rxjs';
import { CallLabRequestDetail } from './call-lab-request-detail';
import { LabFiles } from './lab-files';
import { LAB_RESULT_KEY } from './lab-viewer-sources';
import { labRequest, must } from './testing/lab-fixtures';

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function result(over: Partial<DoctorLabResultDto> = {}): DoctorLabResultDto {
  return {
    id: 'res1',
    uploaded_at: '2026-11-01T10:00:00Z',
    item_ids: ['i1'],
    visible: true,
    reviewable: true,
    document: { title: 'FBC result', type_label: 'Lab report', extension: 'pdf', size_label: '1 MB', viewable: true },
    review: null,
    ...over,
  };
}

@Component({
  imports: [CallLabRequestDetail],
  template: `
    <doc-call-lab-request-detail
      labId="lr1"
      [patientId]="pid()"
      [watermark]="watermark()"
      [active]="active()"
      [sharing]="sharing()"
      [signedIn]="signedIn()"
      (back)="backs = backs + 1"
      (duplicate)="dups.push($event)"
    />
  `,
})
class Host {
  readonly pid = signal<string | null>('p1');
  readonly watermark = signal<{ viewerName: string; timeZone: string } | null>({ viewerName: 'Dr Ada Obi', timeZone: 'Africa/Lagos' });
  readonly active = signal(true);
  readonly sharing = signal(false);
  readonly signedIn = signal(true);
  backs = 0;
  dups: LabRequestDto[] = [];
}

// A first test compiles the whole component tree (JIT): beyond the 5 s default on a busy machine.
describe('CallLabRequestDetail (a lab request inside the call)', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;
  let api: { get: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; review: ReturnType<typeof vi.fn>; viewResult: ReturnType<typeof vi.fn>; resultPrinted: ReturnType<typeof vi.fn> };
  let view: ReturnType<typeof vi.fn>;
  let open: ReturnType<typeof vi.fn>;
  let confirm: ReturnType<typeof vi.fn>;
  let dto: LabRequestDto;

  async function setup(o: { dto?: LabRequestDto; get?: () => Observable<unknown> } = {}) {
    dto = o.dto ?? labRequest({ appointment_id: 'ap-1', results: [result()] });
    api = {
      get: vi.fn(o.get ?? (() => of({ data: dto }))),
      cancel: vi.fn(() => of({ data: { ...dto, status: 'cancelled', can: { cancel: false, review: false, duplicate: true } } })),
      review: vi.fn(() => of({ data: { ...dto, results: [result({ review: { outcome: 'normal', comment: null, reviewed_at: '2026-11-02T10:00:00Z' } })] } })),
      viewResult: vi.fn(),
      resultPrinted: vi.fn(),
    };
    view = vi.fn();
    open = vi.fn();
    confirm = vi.fn(async () => ({ confirmed: true }));
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideSupadocIcons(),
        { provide: LabRequestsApi, useValue: api },
        { provide: LabFiles, useValue: { view } },
        { provide: DocumentViewerService, useValue: { open } },
        { provide: DialogService, useValue: { confirm, confirmLeave: async () => true, requests: signal([]) } },
      ],
    });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
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
  });

  const text = (node: Element | null = el) => node?.textContent?.replace(/\s+/g, ' ') ?? '';
  const button = (label: string, scope: ParentNode = el) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === label) ?? null;
  const status = () => el.querySelector('p.sr-only[role="status"]')?.textContent ?? '';

  it('reads the request once and shows it: number, chip, priority, timeline, results, the request; no link, no Download', async () => {
    await setup();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('lr1');
    expect(text(el.querySelector('#call-lab-detail-number'))).toBe(dto.number);
    expect(text()).toContain('Awaiting Consent');
    expect(text()).toContain('Routine');
    expect(el.querySelector('doc-lab-timeline')).not.toBeNull();
    expect(text(el.querySelector('#call-lab-detail-results')?.parentElement ?? null)).toContain('FBC result');
    expect(el.querySelector('doc-lab-request-summary')).not.toBeNull();
    expect(text()).toContain('From this consultation');
    expect(el.querySelector('a, [href], [routerLink]')).toBeNull();
    expect(text()).not.toContain('Download');
    const title = must(el.querySelector('h2#call-lab-detail-title'), 'title');
    expect(title.getAttribute('tabindex')).toBe('-1');
    expect(el.querySelector('[aria-label="Back to lab requests"]')).not.toBeNull();
  });

  it('View PDF: the request’s PDF in the viewer, focus back to the button', async () => {
    await setup();
    const b = must(button('View PDF'), 'View PDF');
    b.click();
    expect(view).toHaveBeenCalledTimes(1);
    expect(view.mock.calls[0]?.[0]).toMatchObject({ id: dto.id, number: dto.number });
    expect(view.mock.calls[0]?.[1]).toBe(b);
  });

  describe('results', () => {
    it('View: the openable results view-only, from this one, watermarked, no tone, focus falling back to the heading', async () => {
      await setup({ dto: labRequest({ results: [result({ id: 'a' }), result({ id: 'b' })] }) });
      const views = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).filter((b) => b.textContent?.trim() === 'View');
      expect(views.length).toBe(2);
      views[1].click();
      expect(open).toHaveBeenCalledTimes(1);
      const [sources, options] = open.mock.calls[0] as [ViewerSource[], ViewerOpenOptions];
      expect(sources.map((s) => s.key)).toEqual([LAB_RESULT_KEY + 'a', LAB_RESULT_KEY + 'b']);
      expect(sources.every((s) => s.policy === 'view_only')).toBe(true);
      expect(options.index).toBe(1);
      expect(options.watermark).toEqual({ viewerName: 'Dr Ada Obi', timeZone: 'Africa/Lagos' });
      expect(options.listLabel).toBe('results');
      expect(options.opener).toBe(views[1]);
      expect('tone' in options).toBe(false);
      expect(options.fallbackFocus?.()?.id).toBe('call-lab-detail-results');
    });

    it('not shared and not viewable rows say why and offer no View; no watermark, no View', async () => {
      await setup({
        dto: labRequest({
          results: [
            result({ id: 'x', visible: false, document: null }),
            result({ id: 'y', document: { title: 'Scan', type_label: 'Scan', extension: 'dcm', size_label: '9 MB', viewable: false } }),
          ],
        }),
      });
      expect(text()).toContain("Chika hasn't shared this result with you.");
      expect(text()).toContain("Preview isn't available for this file type (DCM).");
      expect(button('View')).toBeNull();
      fixture.destroy();
      el.remove();
      TestBed.resetTestingModule();
      await setup();
      expect(button('View')).not.toBeNull();
      host.watermark.set(null);
      await settle();
      expect(button('View')).toBeNull();
    });

    it('Review: the dialog; saving updates the request and says so', async () => {
      await setup({ dto: labRequest({ results: [result()], can: { cancel: true, review: true, duplicate: true } }) });
      must(button('Review'), 'Review').click();
      await settle();
      const dialog = must(Array.from(document.querySelectorAll('dialog')).find((d) => d.open), 'review dialog');
      (dialog.querySelector('input[type="radio"]') as HTMLInputElement).click();
      await settle();
      must(button('Save review', dialog), 'Save review').click();
      await settle();
      expect(api.review).toHaveBeenCalledWith(dto.id, 'res1', { outcome: 'normal' });
      expect(status()).toContain('Review saved.');
      expect(text()).toContain('Normal');
      expect(button('Change review')).not.toBeNull();
    });
  });

  describe('Cancel request', () => {
    it('asks with a required reason, then cancels; a 409 reloads quietly', async () => {
      await setup();
      must(button('Cancel request'), 'Cancel request').click();
      await settle();
      expect(confirm).toHaveBeenCalledTimes(1);
      const opts = confirm.mock.calls[0][0] as ConfirmOptions;
      expect(opts.reason).toMatchObject({ required: true });
      expect(opts.tone).toBe('danger');
      const run = must(opts.action, 'action')('Not needed any more');
      await (isObservable(run) ? firstValueFrom(run) : run);
      expect(api.cancel).toHaveBeenCalledWith(dto.id, 'Not needed any more');
      api.get.mockClear();
      api.cancel.mockImplementation(() => throwError(() => ({ statusCode: 409, errors: { code: 'status_changed' } })));
      const again = must(opts.action, 'action')('Not needed any more');
      await expect(isObservable(again) ? firstValueFrom(again) : again).rejects.toBeTruthy();
      expect(api.get).toHaveBeenCalledTimes(1);
    });

    it('confirmed: focus on the title (its button is gone), "Request cancelled." announced', async () => {
      await setup();
      confirm.mockImplementation(async (o: ConfirmOptions) => {
        const run = o.action?.('Not needed');
        if (run) await (isObservable(run) ? firstValueFrom(run) : run);
        return { confirmed: true };
      });
      must(button('Cancel request'), 'Cancel request').focus();
      must(button('Cancel request'), 'Cancel request').click();
      await settle();
      await settle();
      expect(button('Cancel request')).toBeNull();
      expect(document.activeElement?.id).toBe('call-lab-detail-title');
      expect(status()).toContain('Request cancelled.');
    });

    it('signed out meanwhile: the action refuses with its own words, nothing is posted', async () => {
      await setup();
      must(button('Cancel request'), 'Cancel request').click();
      await settle();
      const opts = confirm.mock.calls[0][0] as ConfirmOptions;
      host.signedIn.set(false);
      await settle();
      let caught: unknown = null;
      try {
        const run = must(opts.action, 'action')('Not needed');
        await (isObservable(run) ? firstValueFrom(run) : run);
      } catch (e) {
        caught = e;
      }
      expect(caught).not.toBeNull();
      expect(must(opts.errorMessage, 'errorMessage')(caught)).toBe('Sign in again to cancel this request.');
      expect(api.cancel).not.toHaveBeenCalled();
    });
  });

  it('Duplicate emits the request; hidden for another patient’s request', async () => {
    await setup();
    must(button('Duplicate'), 'Duplicate').click();
    expect(host.dups.map((r) => r.id)).toEqual([dto.id]);
    host.pid.set('p9');
    await settle();
    expect(button('Duplicate')).toBeNull();
  });

  it('sharing: no "Abnormal" anywhere, no Review, the note; not sharing: the outcome and Review back', async () => {
    const abnormal = labRequest({
      status: 'result_ready',
      abnormal: true,
      results: [result({ review: { outcome: 'abnormal', comment: 'Low haemoglobin', reviewed_at: '2026-11-02T10:00:00Z' } })],
      can: { cancel: false, review: true, duplicate: true },
    });
    await setup({ dto: abnormal });
    expect(text()).toContain('Abnormal');
    expect(button('Change review')).not.toBeNull();
    host.sharing.set(true);
    await settle();
    expect(text()).not.toMatch(/abnormal/i);
    expect(button('Change review')).toBeNull();
    expect(button('Review')).toBeNull();
    expect(text()).toContain('Review outcomes are hidden while you share your screen.');
    expect(text()).toContain('Reviewed');
    host.sharing.set(false);
    await settle();
    expect(text()).toContain('Abnormal');
    expect(button('Change review')).not.toBeNull();
  });

  it('a cancelled request with an abnormal result: the caption only when not sharing', async () => {
    await setup({ dto: labRequest({ status: 'cancelled', abnormal: true, can: { cancel: false, review: false, duplicate: true } }) });
    expect(text()).toContain('Abnormal result');
    host.sharing.set(true);
    await settle();
    expect(text()).not.toMatch(/abnormal/i);
  });

  describe('reads', () => {
    it('404: "Lab request not found" with Back to lab requests', async () => {
      await setup({ get: () => throwError(() => ({ statusCode: 404 })) });
      expect(text()).toContain('Lab request not found');
      must(button('Back to lab requests'), 'Back').click();
      expect(host.backs).toBe(1);
    });

    it('an error: Try again reads again', async () => {
      await setup({ get: () => throwError(() => ({ statusCode: 0 })) });
      expect(el.querySelector('sd-icon[name="wifi-off"]')).not.toBeNull();
      expect(el.querySelector('#call-lab-detail-number')).toBeNull();
      api.get.mockImplementation(() => of({ data: dto }));
      must(button('Try again'), 'Try again').click();
      await settle();
      expect(api.get).toHaveBeenCalledTimes(2);
      expect(text(el.querySelector('#call-lab-detail-number'))).toBe(dto.number);
    });

    it('shown again (active false → true): exactly one quiet read; a window focus: none; Refresh: one', async () => {
      await setup();
      api.get.mockClear();
      host.active.set(false);
      await settle();
      host.active.set(true);
      await settle();
      expect(api.get).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event('focus'));
      await settle();
      expect(api.get).toHaveBeenCalledTimes(1);
      must(el.querySelector<HTMLButtonElement>('[aria-label="Refresh this lab request"]'), 'Refresh').click();
      await settle();
      expect(api.get).toHaveBeenCalledTimes(2);
      // A quiet read failing keeps what is shown.
      api.get.mockImplementation(() => throwError(() => ({ statusCode: 500 })));
      must(el.querySelector<HTMLButtonElement>('[aria-label="Refresh this lab request"]'), 'Refresh').click();
      await settle();
      expect(text(el.querySelector('#call-lab-detail-number'))).toBe(dto.number);
    });
  });
});
