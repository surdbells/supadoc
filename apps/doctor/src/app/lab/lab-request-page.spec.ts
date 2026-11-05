import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { LabRequestsApi } from '@supadoc/data-access';
import type { DoctorLabResultDto, LabRequestDto } from '@supadoc/models';
import { type ConfirmOptions, DialogService, provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService, type ViewerOpenOptions, type ViewerSource } from '@supadoc/viewer';
import { BehaviorSubject, firstValueFrom, isObservable, type Observable, of, throwError } from 'rxjs';
import { LabFiles } from './lab-files';
import { LabRequestPage } from './lab-request-page';
import { timelineSteps } from './lab-timeline';
import { labRequest, must } from './testing/lab-fixtures';

const pdf = () => new Blob(['%PDF'], { type: 'application/pdf' });

function res(id: string, over: Partial<DoctorLabResultDto> = {}): DoctorLabResultDto {
  return {
    id,
    uploaded_at: '2026-11-05T10:00:00Z',
    item_ids: ['i1'],
    visible: true,
    reviewable: true,
    document: { title: `Result ${id}`, type_label: 'Laboratory Test Report', extension: 'pdf', size_label: '212KB', viewable: true },
    review: null,
    ...over,
  };
}

const ready = (over: Partial<LabRequestDto> = {}) =>
  labRequest({
    status: 'result_ready',
    unreviewed_count: 1,
    results_count: 3,
    lab_name: 'Synlab Ikeja',
    lab_date: '2026-11-06',
    can: { cancel: false, review: true, duplicate: true },
    timeline: [
      { event: 'sent', from_status: null, to_status: 'awaiting_consent', actor_role: 'doctor', actor_name: 'Dr. James Smith', at: '2026-11-04T15:30:00Z', sample_date: null },
      { event: 'accepted', from_status: 'awaiting_consent', to_status: 'booked', actor_role: 'patient', actor_name: 'Chika Osuji', at: '2026-11-04T16:00:00Z', sample_date: null },
      { event: 'status_corrected', from_status: 'booked', to_status: 'in_lab', actor_role: 'staff', actor_name: 'VideoMed support', at: '2026-11-05T08:00:00Z', sample_date: '2026-11-05' },
      { event: 'result_added', from_status: 'in_lab', to_status: 'result_ready', actor_role: 'patient', actor_name: 'Chika Osuji', at: '2026-11-05T10:00:00Z', sample_date: null },
    ],
    results: [
      res('r1'),
      res('r2', { reviewable: false, document: { title: 'Scan', type_label: 'Laboratory Test Report', extension: 'docx', size_label: '1MB', viewable: false } }),
      res('r3', { visible: false, reviewable: false, document: null }),
    ],
    ...over,
  });

describe('LabRequestPage', () => {
  let api: {
    get: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    review: ReturnType<typeof vi.fn>;
    viewResult: ReturnType<typeof vi.fn>;
    resultPrinted: ReturnType<typeof vi.fn>;
    link: ReturnType<typeof vi.fn>;
    fileBlob: ReturnType<typeof vi.fn>;
  };
  let viewer: { open: ReturnType<typeof vi.fn<(s: ViewerSource | readonly ViewerSource[], o?: ViewerOpenOptions) => unknown>> };
  let files: { view: ReturnType<typeof vi.fn>; download: ReturnType<typeof vi.fn> };
  let confirm: ReturnType<typeof vi.spyOn>;
  let el: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<LabRequestPage>>;

  async function setup(dto: LabRequestDto | (() => Observable<unknown>)) {
    api = {
      get: vi.fn(typeof dto === 'function' ? dto : () => of({ data: dto })),
      cancel: vi.fn(() => of({ data: labRequest({ status: 'cancelled', cancel_reason: 'Wrong patient', can: { cancel: false, review: false, duplicate: true } }) })),
      review: vi.fn(() => of({ data: ready({ results: [res('r1', { review: { outcome: 'abnormal', comment: 'Low Hb. Book a follow-up.', reviewed_at: '2026-11-05T11:00:00Z' } })] }) })),
      viewResult: vi.fn(() => of({ blob: pdf(), mime: 'application/pdf', viewRef: 'VM-7F3A2C1D', viewedAt: '2026-11-05T10:05:00Z' })),
      resultPrinted: vi.fn(() => of({ data: { recorded: true } })),
      link: vi.fn(),
      fileBlob: vi.fn(),
    };
    viewer = { open: vi.fn(() => ({ closed: Promise.resolve(), close: () => undefined })) };
    files = { view: vi.fn(), download: vi.fn() };
    TestBed.configureTestingModule({
      imports: [LabRequestPage],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: ActivatedRoute, useValue: { paramMap: new BehaviorSubject(convertToParamMap({ labId: 'lr1' })) } },
        { provide: LabRequestsApi, useValue: api },
        { provide: DocumentViewerService, useValue: viewer },
        { provide: LabFiles, useValue: files },
        { provide: StaffAuthService, useValue: { isAuthenticated: () => true, displayName: () => 'James Smith' } },
      ],
    });
    confirm = vi.spyOn(TestBed.inject(DialogService), 'confirm');
    fixture = TestBed.createComponent(LabRequestPage);
    el = fixture.nativeElement;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const text = (n: Element | null = el) => n?.textContent?.replace(/\s+/g, ' ') ?? '';
  const button = (label: string, scope: ParentNode = el) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === label);
  const rows = () => Array.from(el.querySelectorAll<HTMLElement>('[aria-labelledby="lab-req-results"] li'));

  it('timeline: what happened, "Patient reported" tags, the lab line, a correction with its sample date, then what is ahead', () => {
    const steps = timelineSteps(ready());
    expect(steps.map((s) => [s.label, s.done, s.tag])).toEqual([
      ['Sent', true, null],
      ['Accepted by patient', true, 'Patient reported'],
      ['Updated by VideoMed support: Booked → In Lab', true, null],
      ['Result added', true, null],
      ['Reviewed', false, null],
    ]);
    expect(steps[1].notes).toEqual(['Lab: Synlab Ikeja · Planned for 6 Nov 2026']);
    expect(steps[2].notes).toEqual(['Sample date reported: 5 Nov 2026']);
    const fresh = timelineSteps(labRequest());
    expect(fresh.map((s) => [s.label, s.done])).toEqual([
      ['Sent', true],
      ['Accepted by patient', false],
      ['Sample given', false],
      ['Result added', false],
      ['Reviewed', false],
    ]);
    const declined = timelineSteps(
      labRequest({
        status: 'declined',
        decline_reason: 'Next month',
        timeline: [
          ...labRequest().timeline,
          { event: 'declined', from_status: 'awaiting_consent', to_status: 'declined', actor_role: 'patient', actor_name: 'Chika', at: '2026-11-05T09:00:00Z', sample_date: null },
        ],
      }),
    );
    expect(declined.map((s) => s.label)).toEqual(['Sent', 'Declined by patient']);
    expect(declined[1].notes).toEqual(['Reason: Next month']);
  });

  it('timeline: an expiry computed on read (no stored `expired` event, no cron) still ends with "Expired"', () => {
    // Only a `sent` event; the API reports the effective status and falls back to expires_at.
    const computed = timelineSteps(labRequest({ status: 'expired', expired_at: '2026-12-04T23:00:00Z' }));
    expect(computed.map((s) => [s.label, s.done, s.at])).toEqual([
      ['Sent', true, labRequest().timeline[0].at],
      ['Expired', true, '2026-12-04T23:00:00Z'],
    ]);
    // Without expired_at, the instant validity ended.
    const noStamp = timelineSteps(labRequest({ status: 'expired', expired_at: null }));
    expect(noStamp.at(-1)).toMatchObject({ label: 'Expired', done: true, at: labRequest().expires_at });
    // A stored `expired` event (the sweeper ran): one "Expired" step, not two.
    const stored = timelineSteps(
      labRequest({
        status: 'expired',
        expired_at: '2026-12-04T23:00:00Z',
        timeline: [
          ...labRequest().timeline,
          { event: 'expired', from_status: 'awaiting_consent', to_status: 'expired', actor_role: 'system', actor_name: null, at: '2026-12-04T23:00:00Z', sample_date: null },
        ],
      }),
    );
    expect(stored.map((s) => s.label)).toEqual(['Sent', 'Expired']);
  });

  it('renders the header, timeline (pending steps say "Not yet") and the caption', async () => {
    await setup(ready());
    expect(text(el.querySelector('#lab-req-number'))).toContain('GVM-REQ-20261104-00012');
    expect(text()).toContain('Result ready');
    expect(text()).toContain('Needs review');
    expect(text()).toContain('Chika Osuji · 55 years · Male');
    expect(el.querySelector('a[href="/patients/p1"]')?.textContent).toContain('Open patient record');
    expect(text()).toContain('Not yet: Reviewed');
    expect(text()).toContain('Booked and In Lab are reported by the patient.');
  });

  it('the number can break only after a hyphen (a <wbr> after each part), never inside its digits', async () => {
    await setup(ready());
    const h = must(el.querySelector('#lab-req-number'), '#lab-req-number');
    expect(h.textContent).toBe('GVM-REQ-20261104-00012');
    expect(Array.from(h.querySelectorAll('span'), (p) => p.textContent)).toEqual(['GVM-', 'REQ-', '20261104-', '00012']);
    expect(h.querySelectorAll('span + wbr').length).toBe(4);
    expect(h.classList.contains('break-all')).toBe(false);
  });

  it('results: openable rows have View + Review; DOCX says why and has no Review; unshared rows say so', async () => {
    await setup(ready());
    const [pdfRow, docxRow, hidden] = rows();
    expect(button('View', pdfRow)).toBeTruthy();
    expect(button('Review', pdfRow)).toBeTruthy();
    expect(text(pdfRow)).toContain('Covers: FBC');
    expect(text(docxRow)).toContain("Preview isn't available for this file type (DOCX). Ask the patient to share it as a PDF or photo.");
    expect(button('Review', docxRow)).toBeUndefined();
    expect(button('View', docxRow)).toBeUndefined();
    expect(text(hidden)).toContain("Chika hasn't shared this result with you.");
    expect(button('Review', hidden)).toBeUndefined();
  });

  it('View opens the shared viewer on the openable results (view-only, watermarked); load calls viewResult, Print records first', async () => {
    await setup(ready({ results: [res('r1'), res('r2', { item_ids: [] }), res('r3', { visible: false, document: null })] }));
    must(button('View', rows()[1]), 'button').click();
    expect(viewer.open).toHaveBeenCalledTimes(1);
    const [sources, opts] = viewer.open.mock.calls[0] as [ViewerSource[], ViewerOpenOptions];
    expect(sources.map((s) => s.key)).toEqual(['labres:r1', 'labres:r2']);
    expect(sources.every((s) => s.policy === 'view_only' && !s.download)).toBe(true);
    expect(opts.index).toBe(1);
    expect(opts.watermark?.viewerName).toBeTruthy();
    expect(opts.fallbackFocus?.()?.id).toBe('lab-req-results');
    const file = await firstValueFrom(sources[1].load());
    expect(api.viewResult).toHaveBeenCalledWith('lr1', 'r2');
    await firstValueFrom(must(sources[1].recordPrint, 'recordPrint')(file));
    expect(api.resultPrinted).toHaveBeenCalledWith('lr1', 'r2', 'VM-7F3A2C1D');
  });

  it('review: Abnormal needs a note; saving reloads the request and announces it', async () => {
    await setup(ready());
    must(button('Review', rows()[0]), 'button').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const dlg = must(Array.from(document.querySelectorAll('dialog')).find((d) => d.open && d.textContent?.includes('Review result')), 'element');
    expect(text(dlg)).toContain('Result r1 · FBC');
    expect(text(dlg)).toContain('The patient sees your note. They never see the words Normal or Abnormal.');
    dlg.querySelectorAll<HTMLInputElement>('input[name="lab-review-outcome"]')[1].click();
    fixture.detectChanges();
    must(button('Save review', dlg), 'button').click();
    fixture.detectChanges();
    expect(api.review).not.toHaveBeenCalled();
    expect(text(dlg)).toContain('Add a note for the patient');
    const note = must(dlg.querySelector<HTMLTextAreaElement>('#lab-review-note'), '#lab-review-note');
    note.value = 'Low Hb. Book a follow-up.';
    note.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    must(button('Save review', dlg), 'button').click();
    fixture.detectChanges();
    expect(api.review).toHaveBeenCalledWith('lr1', 'r1', { outcome: 'abnormal', comment: 'Low Hb. Book a follow-up.' });
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('Review saved.');
    expect(text(rows()[0])).toContain('Abnormal');
    expect(text(rows()[0])).toContain('Low Hb. Book a follow-up.');
    expect(button('Change review', rows()[0])).toBeTruthy();
  });

  it('a 409 not_viewable from Save review shows its message and reloads the request', async () => {
    await setup(ready());
    api.review.mockImplementation(() =>
      throwError(() => ({
        statusCode: 409,
        message: "You can't open this file type in VideoMed, so it can't be reviewed. Ask the patient to add a PDF or photo.",
        errors: { code: 'not_viewable' },
      })),
    );
    must(button('Review', rows()[0]), 'button').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const dlg = must(Array.from(document.querySelectorAll('dialog')).find((d) => d.open && d.textContent?.includes('Review result')), 'element');
    dlg.querySelectorAll<HTMLInputElement>('input[name="lab-review-outcome"]')[0].click();
    fixture.detectChanges();
    must(button('Save review', dlg), 'button').click();
    fixture.detectChanges();
    expect(dlg.querySelector('[role="alert"]')?.textContent).toContain("You can't open this file type in VideoMed");
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('Cancel asks for a reason, cancels with it and shows the new state', async () => {
    await setup(labRequest());
    confirm.mockImplementation(async (o: ConfirmOptions) => {
      const r = must(o.action, 'action')('Ordered for the wrong patient');
      if (isObservable(r)) await firstValueFrom(r, { defaultValue: undefined });
      return { confirmed: true, reason: 'Ordered for the wrong patient' };
    });
    must(button('Cancel request'), 'button').click();
    await fixture.whenStable();
    fixture.detectChanges();
    const opts = confirm.mock.calls[0][0] as ConfirmOptions;
    expect(opts).toMatchObject({
      title: 'Cancel this request?',
      message: 'Chika Osuji will be told it was cancelled. You can duplicate it later if needed.',
      tone: 'danger',
      reason: { label: 'Reason for the patient', required: true, minLength: 3, maxLength: 500 },
      confirmLabel: 'Cancel request',
      cancelLabel: 'Keep request',
    });
    expect(api.cancel).toHaveBeenCalledWith('lr1', 'Ordered for the wrong patient');
    expect(text()).toContain('Cancelled');
    expect(button('Cancel request')).toBeUndefined();
  });

  it('Cancel answered 409 status_changed (a result arrived): the dialog keeps the message and the page reloads', async () => {
    await setup(labRequest({ status: 'in_lab' }));
    const conflict = { statusCode: 409, message: 'A result has been added to this request.', errors: { code: 'status_changed' } };
    api.cancel.mockImplementation(() => throwError(() => conflict));
    // Meanwhile the patient uploaded a result.
    api.get.mockImplementation(() => of({ data: ready() }));
    let actionError: unknown = null;
    confirm.mockImplementation(async (o: ConfirmOptions) => {
      const r = must(o.action, 'action')('Ordered for the wrong patient');
      // The dialog shows the failure (its errorMessage) and stays open; the doctor then closes it.
      if (isObservable(r)) await firstValueFrom(r, { defaultValue: undefined }).catch((e: unknown) => (actionError = e));
      return { confirmed: false };
    });
    must(button('Cancel request'), 'button').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(actionError).toBe(conflict);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(button('Cancel request')).toBeUndefined();
    expect(text(el.querySelector('#lab-req-number')?.parentElement ?? null)).toContain('Result ready');
    expect(button('Review', rows()[0])).toBeTruthy();
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('');
  });

  it('Duplicate links to a new form for the same patient; View / Download PDF use the signed link', async () => {
    await setup(labRequest());
    const dup = must(Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.includes('Duplicate')), 'element');
    expect(dup.getAttribute('href')).toBe('/prescriptions/labs/new?patientId=p1&from=lr1');
    must(button('View PDF'), 'button').click();
    expect(files.view).toHaveBeenCalledWith(expect.objectContaining({ id: 'lr1' }), expect.anything());
    must(button('Download PDF'), 'button').click();
    expect(files.download).toHaveBeenCalledWith('lr1', expect.any(Function), expect.any(Function));
  });

  it('the request summary carries its warnings and the signature / validity lines', async () => {
    await setup(
      labRequest({
        priority: 'stat',
        clinical: { ...labRequest().clinical, pregnancy_asked: true, pregnant: true, weeks_pregnant: 12 },
        items: [labRequest().items[0], { ...labRequest().items[1], code: 'CT-HEAD', label: 'CT - Head', short: 'CT - Head', contrast_possible: true }],
      }),
    );
    const t = text(el.querySelector('[aria-labelledby="lab-req-request"]'));
    expect(t).toContain('If this is an emergency, advise the patient to go to the nearest emergency department.');
    expect(t).toContain('Contrast allergy reported. Check before any contrast study.');
    expect(t).toContain('Pregnant patient: check this study is safe in pregnancy before sending.');
    expect(t).toContain('Infection alert: TB, HIV');
    // One colon per pair: the specimen's own 'Venous blood: serum' reads as 'Venous blood (serum)'.
    expect(t).toContain('Specimens: FBC: Venous blood (serum)');
    expect(t).toMatch(/Signed electronically by Dr\. James Smith on /);
    expect(t).toContain('Valid until 4 Dec 2026');
  });

  it('404: "Lab request not found" with the way back', async () => {
    await setup(() => throwError(() => ({ statusCode: 404 })));
    expect(text()).toContain('Lab request not found');
    expect(el.querySelector('a[href="/prescriptions/labs"]')).not.toBeNull();
  });
});
