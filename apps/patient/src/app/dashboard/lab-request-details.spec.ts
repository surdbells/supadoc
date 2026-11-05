import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import {
  ActivatedRoute,
  convertToParamMap,
  provideRouter,
} from '@angular/router';
import {
  BehaviorSubject,
  firstValueFrom,
  isObservable,
  NEVER,
  of,
  throwError,
  type Observable,
} from 'rxjs';
import {
  API_CONFIG,
  DocumentSharingApi,
  DocumentsApi,
  LabRequestsApi,
} from '@supadoc/data-access';
import type {
  AcceptLabRequestInput,
  PatientLabRequestDto,
  PatientLabResultDto,
} from '@supadoc/models';
import {
  DialogService,
  provideSupadocIcons,
  type ConfirmOptions,
} from '@supadoc/ui';
import {
  DocumentViewerService,
  type ViewerOpenOptions,
  type ViewerSource,
} from '@supadoc/viewer';
import { LabRequestDetails } from './lab-request-details';
import { LabResultUploadDialog } from './lab-result-upload-dialog';

const ok = <T>(data: T) => of({ status: 'success', message: 'OK', data });

const STATEMENTS: PatientLabRequestDto['consent_statements'] = [
  {
    key: 'tests',
    text: 'I agree to have the tests in this request.',
    required: true,
    default: false,
  },
  {
    key: 'pays_lab',
    text: "I understand I choose the lab and pay the lab directly. VideoMed doesn't charge for these tests.",
    required: true,
    default: false,
  },
  {
    key: 'lab_disclosure',
    text: 'I understand the request PDF I show the lab includes the clinical details my doctor wrote, such as medicines, allergies and other health information.',
    required: true,
    default: false,
  },
  {
    key: 'share_results',
    text: 'Share the results I add to this request with Dr. Grace Bell.',
    required: false,
    default: true,
  },
];

const result = (
  over: Partial<PatientLabResultDto> = {},
): PatientLabResultDto => ({
  id: 'res-1',
  uploaded_at: '2026-11-06T10:00:00Z',
  item_ids: ['i-1', 'i-2'],
  document: {
    id: 'd-1',
    title: 'FBC result',
    type_label: 'Laboratory Test Report',
    extension: 'pdf',
    size_label: '212KB',
  },
  share_outcome: 'shared',
  shared_now: true,
  viewable: true,
  reviewable: true,
  review: null,
  ...over,
});

function request(
  over: Partial<PatientLabRequestDto> = {},
): PatientLabRequestDto {
  return {
    id: 'lr-1',
    number: 'GVM-REQ-20261104-00012',
    status: 'awaiting_consent',
    priority: 'routine',
    doctor: { id: 'sp-1', name: 'Dr. Grace Bell', specialty: 'Cardiologist' },
    items_count: 2,
    results_count: 0,
    reviewed: false,
    awaiting_review: false,
    appointment_id: null,
    sent_at: '2026-11-04T10:00:00Z',
    valid_until: '2026-12-04',
    expires_at: '2026-12-04T23:00:00Z',
    last_activity_at: '2026-11-04T10:00:00Z',
    clinical_question: 'Suspected iron-deficiency anaemia',
    purpose: 'diagnosis',
    items: [
      {
        id: 'i-1',
        kind: 'lab',
        label: 'FBC - Full Blood Count',
        short: 'FBC',
        specimen_label: 'Whole blood (EDTA)',
        preparation_code: null,
        preparation_label: null,
      },
      {
        id: 'i-2',
        kind: 'imaging',
        label: 'Ultrasound - Pelvis',
        short: 'US',
        specimen_label: null,
        preparation_code: 'full_bladder',
        preparation_label: 'Full bladder',
      },
    ],
    instructions: [
      {
        key: 'bring',
        title: 'Take this request',
        text: 'Show the request PDF at the lab, on your phone or printed, with a photo ID.',
      },
    ],
    consent_version: 'LAB-2026-11.1',
    consent_statements: STATEMENTS,
    consent: null,
    lab_name: null,
    lab_date: null,
    declined_at: null,
    decline_reason: null,
    sample_at: null,
    result_ready_at: null,
    cancelled_at: null,
    cancel_reason: null,
    expired_at: null,
    results_sharing: 'none',
    doctor_available: true,
    results: [],
    timeline: [
      {
        event: 'sent',
        from_status: null,
        to_status: 'awaiting_consent',
        actor_role: 'doctor',
        actor_name: 'Dr. Grace Bell',
        at: '2026-11-04T10:00:00Z',
        sample_date: null,
      },
    ],
    can: {
      accept: true,
      decline: true,
      sample: false,
      upload: false,
      pdf: false,
    },
    result_document_types: [
      { value: 'laboratory_test_report', label: 'Laboratory Test Report' },
    ],
    default_document_type: 'laboratory_test_report',
    ...over,
  };
}

const CONSENT = {
  version: 'LAB-2026-11.1',
  consented_at: '2026-11-04T11:00:00Z',
  share_results: true,
};
const booked = (over: Partial<PatientLabRequestDto> = {}) =>
  request({
    status: 'booked',
    consent: CONSENT,
    can: {
      accept: false,
      decline: false,
      sample: true,
      upload: true,
      pdf: true,
    },
    ...over,
  });

describe('LabRequestDetails', () => {
  let fixture: ComponentFixture<LabRequestDetails>;
  let el: HTMLElement;
  let current: PatientLabRequestDto;
  const realResolved = Intl.DateTimeFormat.prototype.resolvedOptions;

  const mineOne = vi.fn(() => ok(current));
  const accept = vi.fn<
    (id: string, body: AcceptLabRequestInput) => Observable<unknown>
  >(() => ok(booked()));
  const decline = vi.fn(() => ok(null));
  const sampleGiven = vi.fn(() => ok(null));
  const myLink = vi.fn((_id: string, download: boolean): Observable<unknown> =>
    ok({
      url: `/api/public/lab-requests/file?token=${download ? 'dl' : 'view'}`,
      expires_at: '',
      filename: 'GVM-REQ-20261104-00012.pdf',
    }),
  );
  const fileBlob = vi.fn(() =>
    of(new Blob(['%PDF'], { type: 'application/pdf' })),
  );
  const docBlob = vi.fn(() =>
    of(new Blob(['%PDF'], { type: 'application/pdf' })),
  );
  const open = vi.fn();
  const confirm = vi.fn(
    async (
      opts: ConfirmOptions,
    ): Promise<{ confirmed: boolean; reason?: string }> => {
      const done = opts.action?.('Not now');
      if (isObservable(done)) await firstValueFrom(done);
      else await done;
      return { confirmed: true, reason: 'Not now' };
    },
  );
  const confirmLeave = vi.fn(async () => false);
  const clicked: string[] = [];

  /** A save keeps a 30 s timer (the object URL's revoke), so the zone isn't always stable: flush by hand. */
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };
  const text = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const button = (label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.replace(/\s+/g, ' ').trim() === label,
    ) ?? null;
  const lastOpen = () =>
    open.mock.calls[open.mock.calls.length - 1] as [
      ViewerSource | readonly ViewerSource[],
      ViewerOpenOptions,
    ];

  const create = async (r: PatientLabRequestDto, zone = 'Pacific/Auckland') => {
    current = r;
    vi.spyOn(
      Intl.DateTimeFormat.prototype,
      'resolvedOptions',
    ).mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...realResolved.call(this), timeZone: zone };
    });
    await TestBed.configureTestingModule({
      imports: [LabRequestDetails],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: new BehaviorSubject(convertToParamMap({ id: 'lr-1' })),
          },
        },
        {
          provide: LabRequestsApi,
          useValue: {
            mineOne,
            accept,
            decline,
            sampleGiven,
            myLink,
            fileBlob,
            uploadResult: () => NEVER,
          },
        },
        { provide: DocumentsApi, useValue: { fileBlob: docBlob } },
        { provide: DocumentSharingApi, useValue: { doctors: () => ok([]) } },
        { provide: DocumentViewerService, useValue: { open } },
        { provide: DialogService, useValue: { confirm, confirmLeave } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(LabRequestDetails);
    el = fixture.nativeElement;
    document.body.append(el);
    await settle();
  };

  beforeEach(() => {
    for (const f of [
      mineOne,
      accept,
      decline,
      sampleGiven,
      myLink,
      fileBlob,
      docBlob,
      open,
      confirm,
      confirmLeave,
    ])
      f.mockClear();
    clicked.length = 0;
    vi.spyOn(window, 'open').mockReturnValue(null);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:http://localhost/lab'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.getAttribute('href') ?? '');
    });
  });

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    vi.restoreAllMocks();
  });

  describe('awaiting consent', () => {
    it('summary, next step, tests (with the PDF caption) and preparation; dates as calendar dates', async () => {
      await create(request({ priority: 'stat' }));
      expect(text()).toContain('Lab request');
      expect(text()).toContain(
        'Review the request, get ready, and add your results.',
      );
      expect(el.querySelector('#lab-number')?.textContent?.trim()).toBe(
        'GVM-REQ-20261104-00012',
      );
      // It breaks only after a hyphen on a phone (a <wbr> after each part), never inside the digits.
      const number = el.querySelector('#lab-number') as HTMLElement;
      expect(
        Array.from(number.querySelectorAll('span'), (s) => s.textContent),
      ).toEqual(['GVM-', 'REQ-', '20261104-', '00012']);
      expect(number.querySelectorAll('span + wbr')).toHaveLength(4);
      expect(number.classList.contains('break-all')).toBe(false);
      expect(text()).toContain('Action needed');
      expect(text()).toContain('Dr. Grace Bell');
      expect(text()).toContain('Cardiologist');
      expect(text()).toContain('Wed 4 Nov 2026'); // 10:00Z is 11 PM in Auckland: still the 4th
      expect(text()).toContain('STAT — most urgent');
      // valid_until printed from its parts (Auckland is already the 5th at that instant: no shift).
      expect(text()).toContain('Valid until');
      expect(text()).toContain('4 Dec 2026');
      expect(text()).not.toContain('5 Dec 2026');
      expect(text()).toContain(
        'Your doctor marked this request STAT (most urgent).',
      );
      expect(text()).toContain('Review and accept');
      expect(text()).toContain(
        "Read what's requested below, then accept to get your request PDF. You choose the lab and pay it directly.",
      );
      expect(button('Accept request')).toBeTruthy();
      expect(button('Decline')).toBeTruthy();
      expect(text()).toContain(
        'Your request PDF also includes clinical details from your doctor for the lab.',
      );
      expect(text()).toContain('Reason for the tests');
      expect(text()).toContain('Suspected iron-deficiency anaemia');
      expect(text()).toContain('Laboratory (1)');
      expect(text()).toContain('Sample: Whole blood (EDTA)');
      expect(text()).toContain('Imaging (1)');
      expect(text()).toContain('Preparation: Full bladder');
      expect(text()).toContain('How to prepare');
      expect(text()).toContain('Take this request');
      // No PDF before acceptance.
      expect(button('Download PDF')).toBeNull();
      expect(button('View PDF')).toBeNull();
    });

    it('the timeline marks steps to come with a visually hidden "Not yet:" (never an aria-label)', async () => {
      await create(request());
      const steps = Array.from(
        el.querySelectorAll(
          'section[aria-labelledby="lab-timeline-heading"] ol > li',
        ),
      );
      expect(
        steps.map(
          (s) => s.textContent?.replace(/\s+/g, ' ').trim().split(' Wed')[0],
        ),
      ).toEqual([
        'Sent by Dr. Grace Bell',
        'Not yet: You accepted',
        'Not yet: You gave your sample',
        'Not yet: Result added',
        'Not yet: Reviewed by your doctor',
      ]);
      const sample = steps[2];
      expect(sample.querySelector('.sr-only')?.textContent).toBe('Not yet: ');
      expect(sample.querySelector('[aria-label]')).toBeNull();
      expect(sample.getAttribute('aria-label')).toBeNull();
    });

    it('accept: the served statements in order, share pre-ticked, three required; the body carries agree_disclosure', async () => {
      await create(request());
      button('Accept request')?.click();
      await settle();
      expect(text()).toContain('Accept this lab request?');
      const boxes = Array.from(
        el.querySelectorAll<HTMLInputElement>(
          'pat-lab-accept-dialog input[type="checkbox"]',
        ),
      );
      expect(boxes.map((b) => b.dataset['key'])).toEqual([
        'tests',
        'pays_lab',
        'lab_disclosure',
        'share_results',
      ]);
      expect(boxes.map((b) => b.checked)).toEqual([false, false, false, true]);
      expect(boxes.map((b) => b.getAttribute('aria-required'))).toEqual([
        'true',
        'true',
        'true',
        null,
      ]);
      expect(text()).toContain(
        'I understand the request PDF I show the lab includes the clinical details my doctor wrote',
      );
      expect(text()).toContain(
        'Dr. Grace Bell can view and print the files in VideoMed, but not download them.',
      );
      const date = el.querySelector<HTMLInputElement>(
        '#lab-accept-date',
      ) as HTMLInputElement;
      expect(date.getAttribute('max')).toBe('2026-12-04');
      expect(text()).toContain('Before 4 Dec 2026');
      expect(text()).toContain('Lab or imaging centre (optional)');
      expect(text()).toContain('When are you going? (optional)');

      // Nothing ticked: refused here, nothing sent.
      (el.querySelector('#lab-accept-form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { cancelable: true }),
      );
      await settle();
      const required = el.querySelector('#lab-accept-required') as HTMLElement;
      expect(required.textContent?.trim()).toBe(
        'Tick the three required boxes to accept.',
      );
      expect(required.getAttribute('role')).toBe('alert');
      expect(accept).not.toHaveBeenCalled();

      for (const b of boxes.slice(0, 3)) {
        b.checked = true;
        b.dispatchEvent(new Event('change'));
      }
      const name = el.querySelector<HTMLInputElement>(
        '#lab-accept-name',
      ) as HTMLInputElement;
      name.value = 'Synlab Ikeja';
      name.dispatchEvent(new Event('input'));
      date.value = '2026-11-20';
      date.dispatchEvent(new Event('input'));
      await settle();
      (el.querySelector('#lab-accept-form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { cancelable: true }),
      );
      await settle();
      expect(accept).toHaveBeenCalledExactlyOnceWith('lr-1', {
        consent_version: 'LAB-2026-11.1',
        agree_tests: true,
        agree_pays_lab: true,
        agree_disclosure: true,
        share_results: true,
        lab_name: 'Synlab Ikeja',
        lab_date: '2026-11-20',
      });
      expect(text()).toContain(
        'Request accepted. You can now download your request.',
      );
      expect(button('Download PDF')).toBeTruthy();
    });

    it('accept with nothing optional sends neither lab name nor date', async () => {
      await create(request());
      button('Accept request')?.click();
      await settle();
      for (const b of Array.from(
        el.querySelectorAll<HTMLInputElement>(
          'pat-lab-accept-dialog input[type="checkbox"]',
        ),
      ).slice(0, 3)) {
        b.checked = true;
        b.dispatchEvent(new Event('change'));
      }
      (el.querySelector('#lab-accept-form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { cancelable: true }),
      );
      await settle();
      const body = accept.mock.calls[0][1];
      expect('lab_name' in body).toBe(false);
      expect('lab_date' in body).toBe(false);
    });

    it('a changed consent wording reloads the request and asks again', async () => {
      await create(request());
      accept.mockReturnValueOnce(
        throwError(() => ({
          statusCode: 409,
          message: 'The consent wording has changed. Please review it again.',
          errors: { code: 'consent_changed', consent_version: 'LAB-2026-12.1' },
        })),
      );
      button('Accept request')?.click();
      await settle();
      for (const b of Array.from(
        el.querySelectorAll<HTMLInputElement>(
          'pat-lab-accept-dialog input[type="checkbox"]',
        ),
      ).slice(0, 3)) {
        b.checked = true;
        b.dispatchEvent(new Event('change'));
      }
      current = request({
        consent_version: 'LAB-2026-12.1',
        consent_statements: STATEMENTS.map((x) => ({
          ...x,
          text:
            x.key === 'tests' ? 'I agree to the new tests wording.' : x.text,
        })),
      });
      (el.querySelector('#lab-accept-form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { cancelable: true }),
      );
      await settle();
      expect(mineOne).toHaveBeenCalledTimes(2);
      expect(text()).toContain(
        'The consent wording has changed. Please review it again.',
      );
      expect(text()).toContain('I agree to the new tests wording.');
      const boxes = Array.from(
        el.querySelectorAll<HTMLInputElement>(
          'pat-lab-accept-dialog input[type="checkbox"]',
        ),
      );
      expect(boxes.map((b) => b.checked)).toEqual([false, false, false, true]);
    });

    it('a 422 on the date shows under the date', async () => {
      await create(request());
      accept.mockReturnValueOnce(
        throwError(() => ({
          statusCode: 422,
          message: 'Validation failed',
          errors: {
            lab_date: 'Choose a date before this request expires on 4 Dec 2026',
          },
        })),
      );
      button('Accept request')?.click();
      await settle();
      for (const b of Array.from(
        el.querySelectorAll<HTMLInputElement>(
          'pat-lab-accept-dialog input[type="checkbox"]',
        ),
      ).slice(0, 3)) {
        b.checked = true;
        b.dispatchEvent(new Event('change'));
      }
      (el.querySelector('#lab-accept-form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { cancelable: true }),
      );
      await settle();
      expect(el.querySelector('#lab-accept-date-error')?.textContent?.trim()).toBe(
        'Choose a date before this request expires on 4 Dec 2026',
      );
    });

    it('a request cancelled meanwhile (409 status_changed): the dialog closes, the page says why and reloads', async () => {
      await create(request());
      accept.mockReturnValueOnce(
        throwError(() => ({
          statusCode: 409,
          message: 'This request was cancelled.',
          errors: { code: 'status_changed', status: 'cancelled' },
        })),
      );
      button('Accept request')?.click();
      await settle();
      for (const b of Array.from(
        el.querySelectorAll<HTMLInputElement>(
          'pat-lab-accept-dialog input[type="checkbox"]',
        ),
      ).slice(0, 3)) {
        b.checked = true;
        b.dispatchEvent(new Event('change'));
      }
      current = request({
        status: 'cancelled',
        cancelled_at: '2026-11-05T09:00:00Z',
        can: {
          accept: false,
          decline: false,
          sample: false,
          upload: false,
          pdf: false,
        },
      });
      (el.querySelector('#lab-accept-form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { cancelable: true }),
      );
      await settle();
      expect(mineOne).toHaveBeenCalledTimes(2);
      expect(text()).toContain('This request was cancelled.');
      expect(text()).toContain('Dr. Grace Bell cancelled this request on');
    });

    it('decline: an optional reason, then the request is reloaded', async () => {
      await create(request());
      current = request({
        status: 'declined',
        declined_at: '2026-11-05T09:00:00Z',
        decline_reason: 'Not now',
        can: {
          accept: false,
          decline: false,
          sample: false,
          upload: false,
          pdf: false,
        },
      });
      button('Decline')?.click();
      await settle();
      const opts = confirm.mock.calls[0][0];
      expect(opts.title).toBe('Decline this lab request?');
      expect(opts.message).toBe(
        "Dr. Grace Bell will be told you declined. To do these tests later, you'd need a new request.",
      );
      expect(opts.tone).toBe('warning');
      expect(opts.reason).toEqual({
        label: 'Reason',
        required: false,
        maxLength: 500,
      });
      expect(opts.confirmLabel).toBe('Decline request');
      expect(opts.cancelLabel).toBe('Keep request');
      expect(decline).toHaveBeenCalledExactlyOnceWith('lr-1', 'Not now');
      expect(mineOne).toHaveBeenCalledTimes(2);
      expect(text()).toContain('You declined this request on Thu 5 Nov 2026.');
      expect(text()).toContain('Your reason: Not now');
      expect(text()).toContain(
        'If you change your mind, ask your doctor for a new request.',
      );
    });

    it('a decline refused with a 409 (cancelled meanwhile): closing the dialog still reloads the request', async () => {
      await create(request());
      decline.mockReturnValueOnce(
        throwError(() => ({
          statusCode: 409,
          message: 'This request was cancelled.',
          errors: { code: 'status_changed', status: 'cancelled' },
        })) as never,
      );
      // The dialog shows the refusal; the patient closes it ("Keep request").
      confirm.mockImplementationOnce(async (opts: ConfirmOptions) => {
        await expect(
          firstValueFrom(opts.action?.('') as Observable<unknown>),
        ).rejects.toMatchObject({ statusCode: 409 });
        return { confirmed: false };
      });
      current = request({
        status: 'cancelled',
        cancelled_at: '2026-11-05T09:00:00Z',
        can: {
          accept: false,
          decline: false,
          sample: false,
          upload: false,
          pdf: false,
        },
      });
      button('Decline')?.click();
      await settle();
      expect(mineOne).toHaveBeenCalledTimes(2);
      expect(text()).toContain('Dr. Grace Bell cancelled this request on');
      expect(button('Accept request')).toBeNull();
      expect(button('Decline')).toBeNull();
    });

    it('a decline that failed for another reason (offline, 5xx) and was closed keeps the page as it was', async () => {
      await create(request());
      decline.mockReturnValueOnce(
        throwError(() => ({ statusCode: 500, message: '' })) as never,
      );
      confirm.mockImplementationOnce(async (opts: ConfirmOptions) => {
        await expect(
          firstValueFrom(opts.action?.('') as Observable<unknown>),
        ).rejects.toBeTruthy();
        return { confirmed: false };
      });
      button('Decline')?.click();
      await settle();
      expect(mineOne).toHaveBeenCalledTimes(1);
      expect(button('Accept request')).toBeTruthy();
    });
  });

  describe('booked and in the lab', () => {
    it('booked: the plan, the PDF, the sample and the upload', async () => {
      await create(
        booked({ lab_name: 'Synlab Ikeja', lab_date: '2026-11-06' }),
      );
      expect(text()).toContain('Accepted');
      expect(text()).toContain('Take this request to a lab');
      expect(text()).toContain(
        'Any lab or imaging centre can use it. Show the PDF on your phone or print it.',
      );
      expect(text()).toContain('You said: Synlab Ikeja · 6 Nov 2026');
      for (const label of [
        'Download PDF',
        'View PDF',
        "I've given my sample",
        'Upload result',
      ])
        expect(button(label)).toBeTruthy();
    });

    it('View PDF opens the shared viewer (owner), minting the link only when it loads; never a tab', async () => {
      await create(booked());
      const view = button('View PDF') as HTMLButtonElement;
      view.click();
      expect(open).toHaveBeenCalledTimes(1);
      const [source, options] = lastOpen() as [ViewerSource, ViewerOpenOptions];
      expect(source.key).toBe('lab:lr-1');
      expect(source.policy).toBe('owner');
      expect(source.title).toBe('Lab request GVM-REQ-20261104-00012');
      expect(options.opener).toBe(view);
      expect(myLink).not.toHaveBeenCalled();
      await firstValueFrom(source.load());
      expect(myLink).toHaveBeenCalledExactlyOnceWith('lr-1', false);
      expect(fileBlob).toHaveBeenCalledWith({
        url: '/api/public/lab-requests/file?token=view',
      });
      expect(window.open).not.toHaveBeenCalled();
    });

    it('a 409 status_changed in the viewer is not retryable, and reloads the request', async () => {
      await create(booked());
      button('View PDF')?.click();
      const [source] = lastOpen() as [ViewerSource, ViewerOpenOptions];
      const err = {
        statusCode: 409,
        message: 'Accept the request to download it.',
        errors: { code: 'status_changed', status: 'cancelled' },
      };
      expect(source.mapError?.(err)).toEqual({
        state: 'gone',
        text: 'Accept the request to download it.',
        retry: false,
      });
      expect(source.mapError?.({ statusCode: 500, message: '' })).toBeNull();
      source.onGone?.();
      await settle();
      expect(mineOne).toHaveBeenCalledTimes(2);
    });

    it('Download PDF goes through saveSignedLink: a download link fetched as a Blob (no anchor with an API href)', async () => {
      await create(booked());
      button('Download PDF')?.click();
      await settle();
      expect(myLink).toHaveBeenCalledExactlyOnceWith('lr-1', true);
      expect(fileBlob).toHaveBeenCalledWith({
        url: '/api/public/lab-requests/file?token=dl',
      });
      expect(clicked).toEqual(['blob:http://localhost/lab']);
      expect(text()).toContain(
        'Your download has started (GVM-REQ-20261104-00012.pdf).',
      );
      expect(window.open).not.toHaveBeenCalled();
    });

    it('Download PDF: a 409 status_changed shows the API message; anything else the generic line', async () => {
      await create(booked());
      myLink.mockReturnValueOnce(
        throwError(() => ({
          statusCode: 409,
          message: 'Accept the request to download it.',
          errors: { code: 'status_changed' },
        })),
      );
      button('Download PDF')?.click();
      await settle();
      expect(text()).toContain('Accept the request to download it.');
      expect(mineOne).toHaveBeenCalledTimes(2);
      myLink.mockReturnValueOnce(
        throwError(() => ({ statusCode: 500, message: '' })),
      );
      button('Download PDF')?.click();
      await settle();
      expect(text()).toContain("Couldn't open the PDF. Please try again.");
      expect(clicked).toEqual([]);
      // Error text in alert-ink (the alert's own text-alert is < 4.5:1 on its tint).
      expect(
        el.querySelector('sd-alert[tone="error"] span.text-alert-ink')
          ?.textContent,
      ).toBe("Couldn't open the PDF. Please try again.");
    });

    it('"I\'ve given my sample" refused with a 409 (expired meanwhile): closing the dialog reloads the request', async () => {
      await create(booked());
      sampleGiven.mockReturnValueOnce(
        throwError(() => ({
          statusCode: 409,
          message: 'This request has expired.',
          errors: { code: 'expired' },
        })) as never,
      );
      confirm.mockImplementationOnce(async (opts: ConfirmOptions) => {
        await expect(
          firstValueFrom(opts.action?.() as Observable<unknown>),
        ).rejects.toMatchObject({ statusCode: 409 });
        return { confirmed: false };
      });
      current = booked({
        status: 'expired',
        expired_at: '2026-12-04T23:00:00Z',
        can: {
          accept: false,
          decline: false,
          sample: false,
          upload: true,
          pdf: true,
        },
      });
      button("I've given my sample")?.click();
      await settle();
      expect(mineOne).toHaveBeenCalledTimes(2);
      expect(text()).toContain('This request has expired.');
      expect(button("I've given my sample")).toBeNull();
    });

    it('STAT: the full alert while booked; once the sample is given only the emergency sentence', async () => {
      await create(booked({ priority: 'stat' }));
      expect(text()).toContain(
        'Your doctor marked this request STAT (most urgent). Go to a lab as soon as you can. If you feel very unwell, go to the nearest emergency department now.',
      );
      fixture.destroy();
      el.remove();
      TestBed.resetTestingModule();
      await create(
        booked({
          priority: 'stat',
          status: 'in_lab',
          sample_at: '2026-11-06T09:00:00Z',
          can: {
            accept: false,
            decline: false,
            sample: false,
            upload: true,
            pdf: true,
          },
        }),
      );
      expect(text()).toContain(
        'Your doctor marked this request STAT (most urgent). If you feel very unwell, go to the nearest emergency department now.',
      );
      expect(text()).not.toContain('Go to a lab as soon as you can.');
    });

    it('"I\'ve given my sample" asks, records it and reloads', async () => {
      await create(booked());
      current = booked({
        status: 'in_lab',
        sample_at: '2026-11-06T09:00:00Z',
        can: {
          accept: false,
          decline: false,
          sample: false,
          upload: true,
          pdf: true,
        },
      });
      button("I've given my sample")?.click();
      await settle();
      const opts = confirm.mock.calls[0][0];
      expect(opts.title).toBe('Mark your sample as given?');
      expect(opts.message).toBe(
        'Do this after the lab has taken your sample or done your scan. Dr. Grace Bell will see that you have been to the lab.',
      );
      expect(opts.confirmLabel).toBe("Yes, I've given my sample");
      expect(opts.cancelLabel).toBe('Not yet');
      expect(sampleGiven).toHaveBeenCalledExactlyOnceWith('lr-1');
      expect(text()).toContain('Waiting for your results');
      expect(text()).toContain(
        'When the lab gives you your result, add it here so Dr. Grace Bell can review it.',
      );
      expect(button('Upload result')).toBeTruthy();
      expect(button('Download PDF')).toBeTruthy();
    });

    it('asks before leaving while a result uploads, and not otherwise', async () => {
      await create(booked());
      const page = fixture.componentInstance;
      expect(page.canLeave()).toBe(true);
      button('Upload result')?.click();
      await settle();
      const dialog = fixture.debugElement.query(
        By.directive(LabResultUploadDialog),
      ).componentInstance as LabResultUploadDialog;
      dialog.uploading.set(true);
      await expect(page.canLeave()).resolves.toBe(false);
      expect(confirmLeave).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Leave while uploading?',
          confirmLabel: 'Leave anyway',
        }),
      );
    });

    it('a result added: the outcome on the page, focused', async () => {
      await create(booked());
      button('Upload result')?.click();
      await settle();
      const dialog = fixture.debugElement.query(
        By.directive(LabResultUploadDialog),
      ).componentInstance as LabResultUploadDialog;
      const after = booked({
        status: 'result_ready',
        results_count: 1,
        results: [result()],
        awaiting_review: true,
      });
      dialog.uploaded.emit({
        result: result({ share_outcome: 'private' }),
        request: after,
      });
      dialog.closed.emit();
      await settle();
      expect(text()).toContain(
        "Result added. It's private — Dr. Grace Bell can't see it.",
      );
      expect(
        document.activeElement?.contains(el.querySelector('sd-alert')),
      ).toBe(true);
    });

    it('a refused upload (409): the page says why and reloads', async () => {
      await create(booked());
      button('Upload result')?.click();
      await settle();
      const dialog = fixture.debugElement.query(
        By.directive(LabResultUploadDialog),
      ).componentInstance as LabResultUploadDialog;
      current = booked({
        status: 'cancelled',
        cancelled_at: '2026-11-06T09:00:00Z',
        cancel_reason: 'Wrong test',
        can: {
          accept: false,
          decline: false,
          sample: false,
          upload: false,
          pdf: false,
        },
      });
      dialog.refused.emit({ message: 'This request was cancelled.' });
      dialog.closed.emit();
      await settle();
      expect(mineOne).toHaveBeenCalledTimes(2);
      expect(text()).toContain('This request was cancelled.');
      expect(text()).toContain('Dr. Grace Bell cancelled this request on');
      expect(text()).toContain('Reason: Wrong test');
    });
  });

  describe('results', () => {
    const ready = (over: Partial<PatientLabRequestDto> = {}) =>
      booked({
        status: 'result_ready',
        results_count: 1,
        awaiting_review: true,
        results: [result()],
        can: {
          accept: false,
          decline: false,
          sample: false,
          upload: true,
          pdf: true,
        },
        ...over,
      });

    it('one unreviewed result: the help line and "Book a follow-up", shared, waiting for the review', async () => {
      await create(ready());
      expect(text()).toContain('Your results');
      expect(text()).toContain(
        "Worried about a result or feeling unwell? Don't wait for the review — book a consultation, or go to the nearest emergency department if it's urgent.",
      );
      const book = Array.from(el.querySelectorAll('a')).find(
        (a) => a.textContent?.trim() === 'Book a follow-up',
      ) as HTMLAnchorElement;
      expect(book.getAttribute('href')).toBe(
        '/dashboard/appointments/book/sp-1',
      );
      expect(text()).toContain('FBC result');
      expect(text()).toContain('Laboratory Test Report · 212KB · Added');
      expect(text()).not.toContain('Covers:');
      expect(text()).toContain('Shared with Dr. Grace Bell');
      expect(text()).toContain('Waiting for Dr. Grace Bell to review');
      expect(button('Upload another result')).toBeTruthy();
    });

    it('result ready: the request PDF stays available (other tests may still need a lab)', async () => {
      await create(ready({ priority: 'stat' }));
      const group = el.querySelector(
        '[role="group"][aria-labelledby="lab-pdf-heading"]',
      ) as HTMLElement;
      expect(group).toBeTruthy();
      expect(group.textContent?.replace(/\s+/g, ' ')).toContain(
        'Your request PDF Still need other tests from this request? Any lab or imaging centre can use it.',
      );
      // Results are the main content here: neither PDF button is the primary one.
      expect(group.querySelector('button.bg-cerulean')).toBeNull();
      // The Results help line covers emergencies; no STAT alert any more.
      expect(text()).not.toContain('Your doctor marked this request STAT');
      button('Download PDF')?.click();
      await settle();
      expect(myLink).toHaveBeenCalledExactlyOnceWith('lr-1', true);
      expect(clicked).toEqual(['blob:http://localhost/lab']);
      const view = button('View PDF') as HTMLButtonElement;
      view.click();
      const [source, options] = lastOpen() as [ViewerSource, ViewerOpenOptions];
      expect(source.key).toBe('lab:lr-1');
      expect(source.policy).toBe('owner');
      expect(options.opener).toBe(view);
    });

    it('no PDF when the API says there is none (can.pdf false)', async () => {
      await create(
        ready({
          can: {
            accept: false,
            decline: false,
            sample: false,
            upload: true,
            pdf: false,
          },
        }),
      );
      expect(el.querySelector('#lab-pdf-heading')).toBeNull();
      expect(button('Download PDF')).toBeNull();
      expect(button('View PDF')).toBeNull();
    });

    it('reviewed: "Reviewed by your doctor", the date and the note — never an outcome', async () => {
      await create(
        ready({
          reviewed: true,
          awaiting_review: false,
          results: [
            result({
              review: {
                comment: 'Low haemoglobin.\nPlease book a follow-up.',
                reviewed_at: '2026-11-07T09:00:00Z',
              },
            }),
          ],
        }),
      );
      expect(text()).toContain('Reviewed by your doctor');
      expect(text()).toContain('Low haemoglobin.');
      expect(text()).not.toContain('Waiting for Dr. Grace Bell to review');
      expect(text().toLowerCase()).not.toMatch(/normal/);
      // One "Book a follow-up" for the card, not one per review.
      expect(
        Array.from(el.querySelectorAll('a')).filter(
          (a) => a.textContent?.trim() === 'Book a follow-up',
        ),
      ).toHaveLength(1);
    });

    it('private and unviewable rows say why the doctor can’t review them', async () => {
      await create(
        ready({
          awaiting_review: false,
          results: [
            result({
              id: 'res-1',
              shared_now: false,
              reviewable: false,
              item_ids: ['i-1'],
            }),
            result({
              id: 'res-2',
              viewable: false,
              reviewable: false,
              document: {
                id: 'd-2',
                title: 'Report',
                type_label: 'Laboratory Test Report',
                extension: 'docx',
                size_label: '20KB',
              },
            }),
          ],
        }),
      );
      expect(text()).toContain(
        "Private — Dr. Grace Bell can see that you added a result, but not the file, so they can't review it.",
      );
      expect(text()).toContain(
        "Dr. Grace Bell can't open DOCX files. Add the result as a PDF or photo.",
      );
      expect(text()).toContain('Covers: FBC');
      expect(text()).not.toContain('Waiting for Dr. Grace Bell to review');
      expect(text()).not.toContain('Shared with');
    });

    it('the doctor isn’t practising: the alert, "Book another doctor", and no "Shared with"', async () => {
      await create(
        ready({
          doctor_available: false,
          awaiting_review: false,
          results: [result({ shared_now: false, reviewable: false })],
        }),
      );
      expect(text()).toContain(
        "Dr. Grace Bell isn't available on VideoMed right now, so they can't review this result. Book another doctor to go through it.",
      );
      const links = Array.from(el.querySelectorAll('a'));
      expect(
        links
          .find((a) => a.textContent?.trim() === 'Book another doctor')
          ?.getAttribute('href'),
      ).toBe('/dashboard/specialists');
      expect(
        links
          .find((a) => a.textContent?.trim() === 'Book a consultation')
          ?.getAttribute('href'),
      ).toBe('/dashboard/specialists');
      expect(
        links.some((a) => a.textContent?.trim() === 'Book a follow-up'),
      ).toBe(false);
      expect(text()).not.toContain('Shared with');
      expect(text()).not.toContain('Private —');
    });

    it('a result’s View opens the viewer over the request’s results (owner), at that one', async () => {
      await create(
        ready({
          results: [
            result(),
            result({
              id: 'res-2',
              document: { ...result().document, id: 'd-2', title: 'Scan' },
            }),
          ],
        }),
      );
      const view = el.querySelector<HTMLButtonElement>(
        'button[aria-label="View Scan"]',
      ) as HTMLButtonElement;
      view.click();
      const [sources, options] = lastOpen() as [
        readonly ViewerSource[],
        ViewerOpenOptions,
      ];
      expect(sources.map((s) => s.key)).toEqual(['doc:d-1', 'doc:d-2']);
      expect(sources.every((s) => s.policy === 'owner')).toBe(true);
      expect(options.index).toBe(1);
      expect(options.opener).toBe(view);
      await firstValueFrom(sources[1].load());
      expect(docBlob).toHaveBeenCalledWith('d-2');
      expect(window.open).not.toHaveBeenCalled();
    });

    it('cancelled after the sample: the result can still be added', async () => {
      await create(
        booked({
          status: 'cancelled',
          sample_at: '2026-11-06T09:00:00Z',
          cancelled_at: '2026-11-07T09:00:00Z',
          cancel_reason: 'Duplicate request',
          can: {
            accept: false,
            decline: false,
            sample: false,
            upload: true,
            pdf: false,
          },
        }),
      );
      expect(text()).toContain('Cancelled by your doctor');
      expect(text()).toContain(
        'Dr. Grace Bell cancelled this request on Sat 7 Nov 2026.',
      );
      expect(text()).toContain(
        'Already gave your sample? You can still add the result.',
      );
      expect(button('Upload result')).toBeTruthy();
    });

    it('expired (it had been accepted): the valid-until date, and a late result can be added', async () => {
      await create(
        booked({
          status: 'expired',
          expired_at: '2026-12-04T23:00:00Z',
          can: {
            accept: false,
            decline: false,
            sample: false,
            upload: true,
            pdf: true,
          },
        }),
      );
      expect(text()).toContain(
        'This request has expired. It was valid until 4 Dec 2026.',
      );
      expect(text()).toContain('Got your result anyway? You can still add it.');
      expect(button('Upload result')).toBeTruthy();
      // E12: an accepted request keeps its PDF after it expires.
      expect(el.querySelector('#lab-pdf-heading')?.textContent?.trim()).toBe(
        'Your request PDF',
      );
      expect(button('Download PDF')).toBeTruthy();
      expect(button('View PDF')).toBeTruthy();
    });

    it('expired before it was accepted: no late upload and no PDF', async () => {
      await create(
        request({
          status: 'expired',
          expired_at: '2026-12-04T23:00:00Z',
          can: {
            accept: false,
            decline: false,
            sample: false,
            upload: false,
            pdf: false,
          },
        }),
      );
      expect(text()).toContain(
        'This request has expired. It was valid until 4 Dec 2026.',
      );
      expect(text()).not.toContain('Got your result anyway?');
      expect(el.querySelector('#lab-pdf-heading')).toBeNull();
      expect(button('Download PDF')).toBeNull();
      expect(button('View PDF')).toBeNull();
    });
  });

  it('not found and load errors', async () => {
    mineOne.mockReturnValueOnce(
      throwError(() => ({
        statusCode: 404,
        message: 'Lab request not found',
      })) as never,
    );
    await create(request());
    expect(text()).toContain('Lab request not found');
    fixture.destroy();
    el.remove();
    TestBed.resetTestingModule();
    mineOne.mockReturnValueOnce(
      throwError(() => ({ statusCode: 500, message: '' })) as never,
    );
    await create(request());
    expect(text()).toContain("Couldn't load this lab request");
  });
});
