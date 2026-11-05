import type {
  LabRequestStatus,
  PatientLabRequestDto,
  PatientLabResultDto,
} from '@supadoc/models';
import {
  calendarDate,
  coversLabel,
  itemCaption,
  itemGroups,
  labChip,
  labHelper,
  labTimeline,
  numberParts,
  priorityDetail,
  priorityLabel,
  resultCaption,
  resultFileError,
  shareDefault,
  specimenText,
  testsLabel,
  uploadOutcomeMessage,
  type LabItem,
} from './lab-ui';

const chipOf = (
  status: LabRequestStatus,
  over: Partial<{
    reviewed: boolean;
    awaiting_review: boolean;
    results_count: number;
  }> = {},
) =>
  labChip({
    status,
    reviewed: false,
    awaiting_review: false,
    results_count: 0,
    ...over,
  });

const item = (over: Partial<LabItem>): LabItem =>
  ({
    id: 'i-1',
    kind: 'lab',
    label: 'FBC - Full Blood Count',
    short: 'FBC',
    specimen_label: null,
    preparation_code: null,
    preparation_label: null,
    ...over,
  }) as LabItem;

const result = (
  over: Partial<PatientLabResultDto> = {},
): PatientLabResultDto => ({
  id: 'res-1',
  uploaded_at: '2026-11-04T10:00:00Z',
  item_ids: ['i-1'],
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

const SUCCESS = /(^|\s)(bg|text)-(success|sage)(?!-ink)|text-success/;

describe('lab-ui › chips (§4.2)', () => {
  it('maps every status to an icon and a word', () => {
    expect(chipOf('awaiting_consent')).toEqual({
      label: 'Action needed',
      icon: 'circle-alert',
      cls: 'bg-warning/10 text-warning-ink',
    });
    expect(chipOf('booked')).toEqual({
      label: 'Accepted',
      icon: 'circle-check',
      cls: 'bg-frost/60 text-cerulean-dark',
    });
    expect(chipOf('in_lab')).toEqual({
      label: 'Sample given',
      icon: 'hourglass',
      cls: 'bg-teal/10 text-teal-ink',
    });
    expect(chipOf('declined')).toEqual({
      label: 'Declined',
      icon: 'circle-x',
      cls: 'bg-cloud text-slate',
    });
    expect(chipOf('cancelled')).toEqual({
      label: 'Cancelled by your doctor',
      icon: 'circle-x',
      cls: 'bg-cloud text-slate',
    });
    expect(chipOf('expired')).toEqual({
      label: 'Expired',
      icon: 'hourglass',
      cls: 'bg-cloud text-slate',
    });
  });

  it('the reviewed chip is one neutral frost tone, never a success (green) class', () => {
    const reviewed = chipOf('result_ready', {
      reviewed: true,
      results_count: 1,
    });
    expect(reviewed).toEqual({
      label: 'Reviewed by your doctor',
      icon: 'stethoscope',
      cls: 'bg-frost/60 text-cerulean-dark',
    });
    expect(reviewed.cls).not.toMatch(SUCCESS);
    expect(reviewed.cls).not.toContain('sage');
  });

  it('the three result-ready sub-states: awaiting review, reviewed, neither', () => {
    const awaiting = {
      status: 'result_ready' as const,
      reviewed: false,
      awaiting_review: true,
      results_count: 1,
    };
    const reviewed = {
      status: 'result_ready' as const,
      reviewed: true,
      awaiting_review: false,
      results_count: 1,
    };
    const neither = {
      status: 'result_ready' as const,
      reviewed: false,
      awaiting_review: false,
      results_count: 1,
    };
    expect(labChip(awaiting).label).toBe('Result uploaded');
    expect(labChip(awaiting).cls).toBe('bg-sage/10 text-sage-ink');
    expect(labHelper(awaiting, 'Dr. Grace Bell')).toBe(
      'Waiting for Dr. Grace Bell to review',
    );
    expect(labChip(reviewed).label).toBe('Reviewed by your doctor');
    expect(labHelper(reviewed, 'Dr. Grace Bell')).toBe(
      "Open to read your doctor's note",
    );
    expect(labChip(neither).label).toBe('Result uploaded');
    expect(labHelper(neither, 'Dr. Grace Bell')).toBe(
      'Open to see who can review it',
    );
  });

  it('helper lines per status; a cancelled request with results reads as result-ready', () => {
    const at = (status: LabRequestStatus, over = {}) =>
      labHelper(
        {
          status,
          reviewed: false,
          awaiting_review: false,
          results_count: 0,
          ...over,
        },
        'Bayo Ade',
      );
    expect(at('awaiting_consent')).toBe('Review and accept this request');
    expect(at('booked')).toBe('Take this request to a lab');
    expect(at('in_lab')).toBe('Waiting for your results');
    expect(at('declined')).toBe('');
    expect(at('expired')).toBe('');
    expect(at('cancelled')).toBe('');
    expect(at('cancelled', { results_count: 1, awaiting_review: true })).toBe(
      'Waiting for Dr Bayo Ade to review',
    );
  });

  it('never says abnormal or normal', () => {
    const statuses: LabRequestStatus[] = [
      'awaiting_consent',
      'booked',
      'in_lab',
      'result_ready',
      'declined',
      'cancelled',
      'expired',
    ];
    for (const status of statuses) {
      for (const reviewed of [true, false]) {
        const text = `${chipOf(status, { reviewed }).label} ${labHelper({ status, reviewed, awaiting_review: !reviewed, results_count: 1 }, 'X')}`;
        expect(text.toLowerCase()).not.toMatch(/normal/);
      }
    }
  });
});

describe('lab-ui › dates, priorities, counts', () => {
  it('calendarDate prints the Y-m-d parts, never through a Date (so no zone can shift it)', () => {
    const RealDate = globalThis.Date;
    const built = vi.fn();
    globalThis.Date = new Proxy(RealDate, {
      construct(target, args) {
        built();
        return Reflect.construct(target, args);
      },
    });
    try {
      expect(calendarDate('2026-12-04')).toBe('4 Dec 2026');
      expect(calendarDate('2026-01-31')).toBe('31 Jan 2026');
    } finally {
      globalThis.Date = RealDate;
    }
    expect(built).not.toHaveBeenCalled();
    expect(calendarDate('2026-13-01')).toBe('');
    expect(calendarDate('2026-12-04T00:00:00Z')).toBe('');
    expect(calendarDate(null)).toBe('');
  });

  it('priority labels and details', () => {
    expect(priorityLabel('routine')).toBe('Routine');
    expect(priorityLabel('urgent')).toBe('Urgent');
    expect(priorityLabel('stat')).toBe('STAT');
    expect(priorityDetail('routine')).toBe(
      'Routine — results in 24 to 48 hours',
    );
    expect(priorityDetail('urgent')).toBe('Urgent — same day');
    expect(priorityDetail('stat')).toBe('STAT — most urgent');
  });

  it('counts tests', () => {
    expect(testsLabel(1)).toBe('1 test');
    expect(testsLabel(4)).toBe('4 tests');
  });
});

describe('lab-ui › tests requested and results', () => {
  it('groups items by kind (empty groups left out) and captions them', () => {
    const items = [
      item({ id: 'a', kind: 'lab', specimen_label: 'Whole blood (EDTA)' }),
      item({
        id: 'b',
        kind: 'imaging',
        label: 'Ultrasound - Pelvis',
        short: 'US',
        preparation_code: 'full_bladder',
        preparation_label: 'Full bladder',
      }),
      item({
        id: 'c',
        kind: 'imaging',
        label: 'X-Ray - Chest',
        short: 'CXR',
        preparation_code: 'none',
        preparation_label: 'None',
      }),
    ];
    const groups = itemGroups(items);
    expect(groups.map((g) => `${g.title} (${g.items.length})`)).toEqual([
      'Laboratory (1)',
      'Imaging (2)',
    ]);
    expect(itemCaption(items[0])).toBe('Sample: Whole blood (EDTA)');
    expect(itemCaption(items[1])).toBe('Preparation: Full bladder');
    expect(itemCaption(items[2])).toBe('');
  });

  it('"Covers:" only when the result covers part of the request', () => {
    const items = [
      item({ id: 'a', short: 'FBC' }),
      item({ id: 'b', short: 'MP' }),
    ];
    expect(coversLabel({ item_ids: ['a', 'b'] }, items)).toBe('');
    expect(coversLabel({ item_ids: ['b'] }, items)).toBe('Covers: MP');
  });

  it('the row caption: doctor unavailable (none), private, not viewable, shared', () => {
    const req = {
      doctor: { id: 'sp-1', name: 'Dr. Grace Bell', specialty: '' },
      doctor_available: true,
    };
    expect(
      resultCaption({ ...req, doctor_available: false }, result()),
    ).toBeNull();
    expect(resultCaption(req, result({ shared_now: false }))).toBe(
      "Private — Dr. Grace Bell can see that you added a result, but not the file, so they can't review it.",
    );
    expect(
      resultCaption(
        req,
        result({
          viewable: false,
          document: { ...result().document, extension: 'docx' },
        }),
      ),
    ).toBe(
      "Dr. Grace Bell can't open DOCX files. Add the result as a PDF or photo.",
    );
    expect(resultCaption(req, result())).toBe('Shared with Dr. Grace Bell');
  });

  it('the upload share default: active, none + consent; never after the patient stopped sharing', () => {
    const consent = {
      version: 'LAB-2026-11.1',
      consented_at: '',
      share_results: true,
    };
    expect(shareDefault({ results_sharing: 'active', consent: null })).toBe(
      true,
    );
    expect(shareDefault({ results_sharing: 'none', consent })).toBe(true);
    expect(
      shareDefault({
        results_sharing: 'none',
        consent: { ...consent, share_results: false },
      }),
    ).toBe(false);
    expect(shareDefault({ results_sharing: 'ended', consent })).toBe(false);
  });

  it('the four upload outcomes', () => {
    expect(uploadOutcomeMessage('shared', 'Dr. Grace Bell')).toBe(
      'Result added. Dr. Grace Bell can now see it.',
    );
    expect(uploadOutcomeMessage('private', 'Dr. Grace Bell')).toBe(
      "Result added. It's private — Dr. Grace Bell can't see it.",
    );
    expect(uploadOutcomeMessage('sharing_unavailable', 'Dr. Grace Bell')).toBe(
      "Result added. Sharing is unavailable right now, so Dr. Grace Bell can't see it. You can share it from Documents later.",
    );
    expect(uploadOutcomeMessage('doctor_unavailable', 'Dr. Grace Bell')).toBe(
      "Result added. Dr. Grace Bell isn't available on VideoMed right now, so the file stays private.",
    );
  });

  it('result files: the E13 types and 10 MB, with the API messages', () => {
    expect(resultFileError({ name: 'a.PDF', size: 10 })).toBe('');
    expect(resultFileError({ name: 'scan.dcm', size: 10 })).toBe('');
    expect(resultFileError({ name: 'r.docx', size: 10 })).toBe('');
    expect(resultFileError({ name: 'clip.mov', size: 10 })).toBe(
      'Upload a PDF, photo (JPG, PNG, WEBP), DICOM (.dcm) or Word file.',
    );
    expect(resultFileError({ name: 'old.doc', size: 10 })).toBe(
      'Upload a PDF, photo (JPG, PNG, WEBP), DICOM (.dcm) or Word file.',
    );
    expect(
      resultFileError({ name: 'big.pdf', size: 10 * 1024 * 1024 + 1 }),
    ).toBe('File must be 10MB or smaller');
    expect(resultFileError({ name: 'empty.pdf', size: 0 })).toBe(
      'The file is empty',
    );
  });
});

describe('lab-ui › timeline', () => {
  const base = {
    doctor: { id: 'sp-1', name: 'Dr. Grace Bell', specialty: '' },
    sent_at: '2026-11-04T10:00:00Z',
    expires_at: '2026-12-04T23:00:00Z',
    expired_at: null,
  } as Pick<
    PatientLabRequestDto,
    'doctor' | 'sent_at' | 'expires_at' | 'expired_at'
  >;
  const ev = (
    event: PatientLabRequestDto['timeline'][number]['event'],
    at: string,
    over = {},
  ) =>
    ({
      event,
      from_status: null,
      to_status: null,
      actor_role: 'patient',
      actor_name: null,
      at,
      sample_date: null,
      ...over,
    }) as PatientLabRequestDto['timeline'][number];

  it('done steps in order, then the steps still to come (muted), reminders left out', () => {
    const steps = labTimeline(
      {
        ...base,
        status: 'booked',
        timeline: [
          ev('sent', '2026-11-04T10:00:00Z'),
          ev('reminded', '2026-11-05T10:00:00Z'),
          ev('accepted', '2026-11-05T11:00:00Z'),
        ],
      },
      'UTC',
    );
    expect(steps.map((s) => [s.label, s.done])).toEqual([
      ['Sent by Dr. Grace Bell', true],
      ['You accepted', true],
      ['You gave your sample', false],
      ['Result added', false],
      ['Reviewed by your doctor', false],
    ]);
    expect(steps[0].at).toBe('Wed 4 Nov 2026, 10:00 AM');
    expect(steps[2].at).toBe('');
  });

  it('terminal states end the list; an expiry computed on read still shows', () => {
    const declined = labTimeline(
      {
        ...base,
        status: 'declined',
        timeline: [
          ev('sent', base.sent_at),
          ev('declined', '2026-11-05T09:00:00Z'),
        ],
      },
      'UTC',
    );
    expect(declined.map((s) => s.label)).toEqual([
      'Sent by Dr. Grace Bell',
      'You declined',
    ]);
    const expired = labTimeline(
      { ...base, status: 'expired', timeline: [ev('sent', base.sent_at)] },
      'UTC',
    );
    expect(expired.map((s) => s.label)).toEqual([
      'Sent by Dr. Grace Bell',
      'Expired',
    ]);
    expect(expired.every((s) => s.done)).toBe(true);
  });

  it('a support correction reads "Updated by VideoMed support" with the reported sample date', () => {
    const steps = labTimeline(
      {
        ...base,
        status: 'in_lab',
        timeline: [
          ev('sent', base.sent_at),
          ev('accepted', '2026-11-05T09:00:00Z'),
          ev('status_corrected', '2026-11-06T09:00:00Z', {
            actor_role: 'staff',
            sample_date: '2026-11-05',
          }),
        ],
      },
      'UTC',
    );
    expect(steps.map((s) => s.label)).toEqual([
      'Sent by Dr. Grace Bell',
      'You accepted',
      'Updated by VideoMed support',
      'Result added',
      'Reviewed by your doctor',
    ]);
    expect(steps[2].note).toBe('Sample given on 5 Nov 2026');
  });

  it('specimenText keeps one colon in "Sample: …"; numberParts cuts a number after each hyphen', () => {
    expect(itemCaption(item({ specimen_label: 'Venous blood: serum' }))).toBe(
      'Sample: Venous blood (serum)',
    );
    expect(specimenText('Venous blood: plasma (EDTA)')).toBe(
      'Venous blood (plasma, EDTA)',
    );
    expect(specimenText('Whole blood (EDTA)')).toBe('Whole blood (EDTA)');
    expect(numberParts('GVM-REQ-20261105-00001')).toEqual([
      'GVM-',
      'REQ-',
      '20261105-',
      '00001',
    ]);
    expect(numberParts('')).toEqual([]);
  });
});
