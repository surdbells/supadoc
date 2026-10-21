import type {
  DoctorAccessSummaryDto,
  DocumentAccessEventDto,
  DocumentGrantDto,
  DocumentSharedWithDto,
  SharingAppointmentRefDto,
  SharingDoctorDto,
  UploadedDocumentDto,
} from '@supadoc/models';
import {
  accessChip,
  accessUntilLabel,
  accessUntilPhrase,
  bookedShareLine,
  bookingDocumentShare,
  bookingShareCards,
  bookingShareReady,
  bookingShareSummary,
  canSubmitShare,
  defaultDuration,
  defaultFolderTicks,
  doctorStatus,
  doctorSummary,
  durationChoices,
  endedGrantSummary,
  endLabel,
  endsBeforeNext,
  folderNotice,
  grantSummary,
  historyRows,
  labelAt,
  otherFolderHolders,
  requestStatusCopy,
  shareEnd,
  shareInput,
  shareResultLine,
  untilDateError,
  untilDateToExpiresAt,
  untilLabel,
  uploadOutcomeLines,
  uploadShareOptions,
  type ShareFormState,
} from './document-sharing';

const TZ = 'Africa/Lagos';

function appt(over: Partial<SharingAppointmentRefDto> = {}): SharingAppointmentRefDto {
  return {
    id: 'ap-1',
    scheduled_at: '2026-10-28T15:00:00Z',
    ends_at: '2026-10-28T15:30:00Z',
    after_options: {
      after_24h: '2026-10-29T15:30:00Z',
      after_7d: '2026-11-04T15:30:00Z',
      after_30d: '2026-11-27T15:30:00Z',
    },
    ...over,
  };
}

function access(over: Partial<DoctorAccessSummaryDto> = {}): DoctorAccessSummaryDto {
  return {
    state: 'none',
    scope: null,
    document_count: 0,
    until: null,
    until_label_at: null,
    indefinite: false,
    folder_until_label_at: null,
    folder_indefinite: false,
    next_change_at: null,
    last_viewed_at: null,
    active_grant_ids: [],
    hidden_count: 0,
    hidden_document_ids: [],
    ...over,
  };
}

function doctor(
  id: string,
  name: string,
  accessOver: Partial<DoctorAccessSummaryDto> = {},
  over: Partial<SharingDoctorDto> = {},
): SharingDoctorDto {
  return {
    specialist: { id, name, specialty: 'Cardiology', photo_url: null },
    can_share: true,
    unavailable_reason: null,
    last_appointment_at: null,
    next_appointment: null,
    access: access(accessOver),
    pending_request: null,
    requests_blocked: false,
    ...over,
  };
}

function grant(over: Partial<DocumentGrantDto> = {}): DocumentGrantDto {
  return {
    id: 'g-1',
    specialist: { id: 'sp-1', name: 'Bayo Ade', specialty: null, photo_url: null },
    scope: 'all',
    status: 'active',
    source: 'share',
    surface: 'manage_sharing',
    duration: 'until',
    starts_at: '2026-10-20T10:00:00Z',
    expires_at: '2026-10-31T00:00:00+01:00',
    until_label_at: '2026-10-30T23:59:59+01:00',
    ended_at: null,
    end_reason: null,
    ended_by: null,
    document_ids: [],
    document_count: 0,
    appointment: null,
    request_id: null,
    revoke_batch_id: null,
    restorable_until: null,
    last_accessed_at: null,
    access_count: 0,
    created_at: '2026-10-20T10:00:00Z',
    ...over,
  };
}

function shared(over: Partial<DocumentSharedWithDto> = {}): DocumentSharedWithDto {
  return {
    specialist_id: 'sp-1',
    name: 'Bayo Ade',
    via: 'document',
    until: '2026-10-31T00:00:00+01:00',
    until_label_at: '2026-10-30T23:59:59+01:00',
    indefinite: false,
    paused: false,
    ...over,
  };
}

function event(over: Partial<DocumentAccessEventDto>): DocumentAccessEventDto {
  return {
    id: 'e-1',
    event: 'viewed',
    actor: 'doctor',
    specialist: { id: 'sp-1', name: 'Bayo Ade', specialty: null, photo_url: null },
    document: { id: 'd-1', title: 'Chest X-ray' },
    grant_id: null,
    request_id: null,
    details: null,
    created_at: '2026-10-21T10:00:00Z',
    ...over,
  };
}

describe('labels', () => {
  it('formats only the label instant: a date for 23:59 and midnight, a time otherwise', () => {
    expect(untilLabel('2026-10-30T23:59:59+01:00', false, TZ)).toBe('Until 30 Oct 2026');
    expect(labelAt('2026-10-31T00:00:00+01:00', TZ)).toBe('31 Oct 2026');
    expect(untilLabel('2026-10-28T15:30:00Z', false, TZ)).toBe('Until 28 Oct 2026, 4:30 PM');
  });

  it('says "No end date" for an open share and nothing when there is no end at all', () => {
    expect(untilLabel(null, true)).toBe('No end date');
    expect(untilLabel('2026-10-30T23:59:59Z', true)).toBe('No end date');
    expect(untilLabel(null, false)).toBe('');
    expect(untilLabel('not a date', false)).toBe('');
  });
});

describe('untilDateToExpiresAt', () => {
  it('is the start of the next day in the viewer zone, with its offset', () => {
    expect(untilDateToExpiresAt('2026-10-30', 'Africa/Lagos')).toBe('2026-10-31T00:00:00+01:00');
    expect(untilDateToExpiresAt('2026-12-31', 'UTC')).toBe('2027-01-01T00:00:00+00:00');
    expect(untilDateToExpiresAt('2026-07-01', 'America/New_York')).toBe('2026-07-02T00:00:00-04:00');
  });

  it('follows a daylight-saving change', () => {
    expect(untilDateToExpiresAt('2026-03-28', 'Europe/London')).toBe('2026-03-29T00:00:00+00:00');
    expect(untilDateToExpiresAt('2026-03-29', 'Europe/London')).toBe('2026-03-30T00:00:00+01:00');
  });

  it('refuses anything that is not a date', () => {
    expect(untilDateToExpiresAt('30/10/2026', TZ)).toBe('');
  });

  it('checks the picker range', () => {
    const bounds = { min: '2026-10-22', max: '2027-10-21' };
    expect(untilDateError('2026-10-22', bounds)).toBe('');
    expect(untilDateError('2026-10-21', bounds)).toMatch(/^Choose a date between tomorrow and 21 Oct 2027\.$/);
    expect(untilDateError('', bounds)).not.toBe('');
  });
});

describe('durationChoices', () => {
  const now = Date.parse('2026-10-28T10:00:00Z');

  it('offers the appointment ends first, labelled with their real end, then the fixed choices', () => {
    const list = durationChoices(appt(), now, TZ);
    expect(list.map((c) => c.value)).toEqual([
      'after_24h',
      'after_7d',
      'after_30d',
      '24h',
      '7d',
      '30d',
      'until',
      'indefinite',
    ]);
    expect(list[0].label).toBe('Until 24 hours after your 28 Oct consultation (29 Oct 2026, 4:30 PM)');
    expect(list[1].label).toBe('Until 7 days after (4 Nov 2026, 4:30 PM)');
    expect(list.at(-1)?.hint).toBe('They can see them until you stop sharing.');
    expect(defaultDuration(list)).toBe('after_24h');
  });

  it('hides null options and ends within the hour; the default falls back to 7 days', () => {
    const ended = appt({ after_options: { after_24h: null, after_7d: '2026-10-28T10:30:00Z', after_30d: '2026-11-20T00:00:00Z' } });
    const list = durationChoices(ended, now, TZ);
    expect(list.map((c) => c.value).slice(0, 2)).toEqual(['after_30d', '24h']);
    expect(defaultDuration(list)).toBe('7d');
    expect(durationChoices(null, now).map((c) => c.value)).toEqual(['24h', '7d', '30d', 'until', 'indefinite']);
  });

  it('computes an end and labels "until" ends as the day chosen', () => {
    const at = Date.parse('2026-10-21T08:00:00Z');
    expect(shareEnd('24h', { now: at })).toBe('2026-10-22T08:00:00.000Z');
    expect(shareEnd('indefinite')).toBeNull();
    expect(shareEnd('until', { untilDate: '' })).toBeUndefined();
    const until = shareEnd('until', { untilDate: '2026-10-30', tz: TZ });
    expect(until).toBe('2026-10-31T00:00:00+01:00');
    expect(endLabel('until', until, TZ)).toBe('30 Oct 2026');
    expect(shareEnd('after_7d', { appointment: appt() })).toBe('2026-11-04T15:30:00Z');
  });
});

describe('endsBeforeNext', () => {
  const next = appt({ scheduled_at: '2026-11-02T09:00:00Z' });
  it('warns only when a dated end comes before the next consultation', () => {
    expect(endsBeforeNext('2026-11-01T00:00:00Z', next)).toBe(true);
    expect(endsBeforeNext('2026-11-03T00:00:00Z', next)).toBe(false);
    expect(endsBeforeNext(null, next)).toBe(false);
    expect(endsBeforeNext('2026-11-01T00:00:00Z', null)).toBe(false);
  });
});

describe('accessChip', () => {
  it('is hidden when the API did not say, private when nobody can see it', () => {
    expect(accessChip(undefined)).toBeNull();
    expect(accessChip([])).toEqual({ icon: 'lock', label: 'Private', cls: 'bg-cloud text-slate', until: '' });
  });

  it('names one doctor, counts several, and takes the latest end (no end wins)', () => {
    const one = accessChip([shared()], TZ);
    expect(one?.label).toBe('Shared with Dr Bayo Ade');
    expect(one?.icon).toBe('share-2');
    expect(one?.until).toBe('Until 30 Oct 2026');
    const two = accessChip([shared(), shared({ specialist_id: 'sp-2', name: 'Dr Ada Obi', indefinite: true, until: null, until_label_at: null })], TZ);
    expect(two?.label).toBe('Shared with 2 doctors');
    expect(two?.until).toBe('No end date');
  });

  it('flags a paused doctor with a warning pill', () => {
    const chip = accessChip([shared({ paused: true })]);
    expect(chip?.label).toBe('Shared with Dr Bayo Ade · paused');
    expect(chip?.cls).toBe('bg-warning/15 text-warning-ink');
  });
});

describe('doctor cards', () => {
  it('summarises what a doctor can see', () => {
    expect(doctorSummary(doctor('sp-1', 'Bayo Ade'))).toBe("Can't see any of your documents");
    expect(doctorSummary(doctor('sp-1', 'Bayo Ade', { state: 'active', scope: 'selected', document_count: 3 }))).toBe(
      'Can see 3 documents',
    );
    expect(
      doctorSummary(doctor('sp-1', 'Bayo Ade', { state: 'active', scope: 'all', document_count: 9, hidden_count: 2 })),
    ).toBe('Can see all your documents, including new uploads · 2 hidden from them');
    const folderAndOne = doctor('sp-1', 'Bayo Ade', { state: 'active', scope: 'all', document_count: 9 });
    expect(
      doctorSummary(folderAndOne, [grant(), grant({ id: 'g-2', scope: 'selected', document_ids: ['d-9'], document_count: 1 })]),
    ).toBe('Can see all your documents, including new uploads, and 1 shared individually');
  });

  it('shows one status pill: paused, request waiting, sharing or not sharing', () => {
    expect(doctorStatus(doctor('a', 'A', { state: 'paused' })).label).toBe('Paused');
    expect(doctorStatus(doctor('a', 'A', { state: 'active' })).label).toBe('Sharing');
    expect(doctorStatus(doctor('a', 'A')).label).toBe('Not sharing');
  });

  it('describes each share and each ended share', () => {
    expect(grantSummary(grant(), TZ)).toBe('Whole folder · Until 30 Oct 2026 · Shared 20 Oct 2026');
    expect(
      grantSummary(
        grant({ scope: 'selected', document_count: 2, duration: 'indefinite', expires_at: null, until_label_at: null, source: 'request' }),
        TZ,
      ),
    ).toBe('2 documents · No end date · Shared 20 Oct 2026 · from their request');
    expect(
      endedGrantSummary(grant({ status: 'revoked', end_reason: 'revoked', ended_by: 'patient', ended_at: '2026-10-25T10:00:00Z' }), TZ),
    ).toBe('Dr Bayo Ade · Whole folder · Ended 25 Oct 2026 (Stopped by you)');
    expect(endedGrantSummary(grant({ status: 'expired', end_reason: 'expired', ended_at: '2026-10-31T00:00:00+01:00' }), TZ)).toContain(
      '(Time ran out)',
    );
  });

  it('tells extend from unchanged on the review step', () => {
    const holder = doctor('sp-1', 'Bayo Ade', {
      state: 'active',
      scope: 'all',
      folder_until_label_at: '2026-10-30T23:59:59+01:00',
    });
    expect(folderNotice(holder, '2026-11-06T00:00:00+01:00', '5 Nov 2026', TZ)).toBe(
      'Dr Bayo Ade can already see your whole folder until 30 Oct 2026. This extends it to 5 Nov 2026.',
    );
    expect(folderNotice(holder, '2026-10-25T00:00:00+01:00', '24 Oct 2026', TZ)).toBe(
      'Dr Bayo Ade can already see your whole folder until 30 Oct 2026. That stays as it is.',
    );
    expect(folderNotice(holder, null, 'No end date', TZ)).toContain('This extends it to no end date.');
    const open = doctor('sp-1', 'Bayo Ade', { state: 'active', scope: 'all', folder_indefinite: true });
    expect(folderNotice(open, null, '', TZ)).toBe(
      'Dr Bayo Ade can already see your whole folder with no end date. That stays as it is.',
    );
    expect(folderNotice(doctor('sp-1', 'Bayo Ade'), null, '', TZ)).toBe('');
  });

  it("a folder holder's end is the folder share's own, not the latest end of all their shares", () => {
    // Whole folder until 30 Oct + one document with no end date: new uploads stop on 30 Oct.
    const folderAndOpenDoc = access({
      state: 'active',
      scope: 'all',
      until_label_at: null,
      indefinite: true,
      folder_until_label_at: '2026-10-30T23:59:59+01:00',
      folder_indefinite: false,
    });
    expect(accessUntilPhrase(folderAndOpenDoc, TZ)).toBe('until 30 Oct 2026');
    expect(accessUntilLabel(folderAndOpenDoc, TZ)).toBe('Until 30 Oct 2026');

    const openFolder = access({ state: 'active', scope: 'all', indefinite: true, folder_indefinite: true });
    expect(accessUntilPhrase(openFolder, TZ)).toBe('with no end date');
    expect(accessUntilLabel(openFolder, TZ)).toBe('No end date');

    // Selected documents only: the latest end of those shares.
    const some = access({ state: 'active', scope: 'selected', until_label_at: '2026-11-04T16:30:00+01:00', document_count: 2 });
    expect(accessUntilPhrase(some, TZ)).toBe('until 4 Nov 2026, 4:30 PM');
    const someOpen = access({ state: 'active', scope: 'selected', indefinite: true, document_count: 2 });
    expect(accessUntilLabel(someOpen, TZ)).toBe('No end date');
  });
});

describe('historyRows', () => {
  it('folds repeat views of one document by one doctor within 10 minutes', () => {
    const rows = historyRows([
      event({ id: 'v3', created_at: '2026-10-21T10:18:00Z' }),
      event({ id: 'v2', created_at: '2026-10-21T10:12:00Z' }),
      event({ id: 'v1', created_at: '2026-10-21T10:04:00Z' }),
      event({ id: 'v0', created_at: '2026-10-21T09:40:00Z' }),
      event({ id: 'o1', document: { id: 'd-2', title: 'Lab report' }, created_at: '2026-10-21T09:39:00Z' }),
    ]);
    expect(rows.map((r) => [r.key, r.count])).toEqual([
      ['v3', 3],
      ['v0', 1],
      ['o1', 1],
    ]);
    expect(rows[0].text).toBe('Dr Bayo Ade opened Chest X-ray (3 times)');
    expect(rows[1].text).toBe('Dr Bayo Ade opened Chest X-ray');
  });

  it('words every event without guessing a removed document', () => {
    const [sharedRow, removed, away, request] = historyRows(
      [
        event({
          id: 's',
          event: 'shared',
          actor: 'patient',
          document: null,
          details: { scope: 'all', duration: 'until', until_label_at: '2026-10-30T23:59:59+01:00' },
        }),
        event({ id: 'r', event: 'document_removed', actor: 'patient', document: { id: 'gone', title: null } }),
        event({ id: 'x', event: 'revoked', actor: 'system', document: null, details: { end_reason: 'doctor_unavailable' } }),
        event({ id: 'q', event: 'request_expired', actor: 'system', document: null }),
      ],
      TZ,
    );
    expect(sharedRow.text).toBe('You shared your whole folder with Dr Bayo Ade · Until 30 Oct 2026');
    expect(removed.text).toBe("You removed Dr Bayo Ade's access to a document you removed");
    expect(away.text).toBe('Sharing with Dr Bayo Ade ended because they were away from VideoMed');
    expect(request.text).toBe("Dr Bayo Ade's request closed without an answer");
    expect(request.icon).toBe('clock');
  });

  it("tells a stop from a merge or an emptied share, and a doctor's withdrawal from a closed request", () => {
    const [stopped, merged, emptied, withdrawn, closed] = historyRows(
      [
        event({ id: 'a', event: 'revoked', actor: 'patient', document: null, details: { end_reason: 'revoked' } }),
        event({ id: 'b', event: 'revoked', actor: 'patient', document: null, details: { end_reason: 'merged' } }),
        event({ id: 'c', event: 'revoked', actor: 'patient', document: null, details: { end_reason: 'emptied' } }),
        event({ id: 'd', event: 'request_cancelled', actor: 'doctor', document: null }),
        event({ id: 'e', event: 'request_cancelled', actor: 'system', document: null }),
      ],
      TZ,
    );
    expect(stopped.text).toBe('You stopped sharing with Dr Bayo Ade');
    expect(merged).toEqual(
      expect.objectContaining({ icon: 'folder-open', text: 'Your shares with Dr Bayo Ade were combined into one whole-folder share' }),
    );
    expect(emptied.text).toBe('Your share with Dr Bayo Ade ended because no documents were left in it');
    expect(withdrawn.text).toBe('Dr Bayo Ade withdrew their request');
    expect(closed.text).toBe("Dr Bayo Ade's request closed");
  });
});

describe('requestStatusCopy', () => {
  it('has the info copy for every closed status', () => {
    expect(requestStatusCopy('approved', 'Bayo Ade')).toBe("You've already approved this request.");
    expect(requestStatusCopy('declined', 'Bayo Ade')).toBe('You declined this request.');
    expect(requestStatusCopy('cancelled', 'Bayo Ade')).toBe('Dr Bayo Ade withdrew this request.');
    expect(requestStatusCopy('expired', 'Bayo Ade')).toBe('This request closed without an answer. Nothing was shared.');
    expect(requestStatusCopy('pending', 'Bayo Ade')).toBe('');
  });
});

describe('the share form', () => {
  const bounds = { min: '2026-10-22', max: '2027-10-21' };
  const base: ShareFormState = {
    doctorIds: ['sp-1'],
    scope: 'all',
    documentIds: [],
    duration: '7d',
    untilDate: '',
    appointment: null,
  };

  it('needs 1–5 doctors, a scope with documents, and a usable end', () => {
    expect(canSubmitShare(base, bounds)).toBe(true);
    expect(canSubmitShare({ ...base, doctorIds: [] }, bounds)).toBe(false);
    expect(canSubmitShare({ ...base, doctorIds: ['a', 'b', 'c', 'd', 'e', 'f'] }, bounds)).toBe(false);
    expect(canSubmitShare({ ...base, scope: null }, bounds)).toBe(false);
    expect(canSubmitShare({ ...base, scope: 'selected' }, bounds)).toBe(false);
    expect(canSubmitShare({ ...base, scope: 'selected', documentIds: ['d-1'] }, bounds)).toBe(true);
    expect(canSubmitShare({ ...base, duration: 'until' }, bounds)).toBe(false);
    expect(canSubmitShare({ ...base, duration: 'until', untilDate: '2026-11-01' }, bounds)).toBe(true);
    expect(canSubmitShare({ ...base, duration: 'after_24h' }, bounds)).toBe(false);
    expect(canSubmitShare({ ...base, duration: 'after_24h', appointment: appt() }, bounds)).toBe(true);
  });

  it('builds the POST body: until end, anchored appointment, Show them too and the request', () => {
    const until = shareInput(
      { ...base, scope: 'selected', documentIds: ['d-1'], duration: 'until', untilDate: '2026-10-30' },
      { clientKey: 'k-1', surface: 'manage_sharing', tz: TZ, showHiddenFor: ['sp-1'] },
    );
    expect(until).toEqual({
      specialist_ids: ['sp-1'],
      scope: 'selected',
      document_ids: ['d-1'],
      duration: 'until',
      expires_at: '2026-10-31T00:00:00+01:00',
      client_key: 'k-1',
      surface: 'manage_sharing',
    });
    const after = shareInput(
      { ...base, duration: 'after_24h', appointment: appt() },
      { clientKey: 'k-2', surface: 'call', answersRequestId: 'rq-1', showHiddenFor: ['sp-1', 'sp-9'] },
    );
    expect(after.appointment_id).toBe('ap-1');
    expect(after.answers_request_id).toBe('rq-1');
    expect(after.show_hidden_for_specialist_ids).toEqual(['sp-1']);
    expect(after.document_ids).toBeUndefined();
    // Any other end leaves the consultation out (the API refuses a proposal's id).
    const relative = shareInput({ ...base, duration: '7d', appointment: appt() }, { clientKey: 'k-3', surface: 'appointment_details' });
    expect(relative.appointment_id).toBeUndefined();
  });

  it('builds the success line from the answer', () => {
    const g = grant({ duration: 'until' });
    expect(shareResultLine({ grants: [g], outcomes: [{ specialist_id: 'sp-1', grant_id: 'g-1', outcome: 'created' }], approved_request_ids: [], replayed: false }, TZ)).toBe(
      'Shared with Dr Bayo Ade until 30 Oct 2026.',
    );
    expect(shareResultLine({ grants: [g], outcomes: [{ specialist_id: 'sp-1', grant_id: 'g-1', outcome: 'unchanged' }], approved_request_ids: [], replayed: false }, TZ)).toBe(
      'Dr Bayo Ade could already see your whole folder until 30 Oct 2026.',
    );
    expect(
      shareResultLine(
        {
          grants: [g, grant({ id: 'g-2' })],
          outcomes: [
            { specialist_id: 'sp-1', grant_id: 'g-1', outcome: 'created' },
            { specialist_id: 'sp-2', grant_id: 'g-2', outcome: 'created' },
          ],
          approved_request_ids: [],
          replayed: false,
        },
        TZ,
      ),
    ).toBe('Shared with 2 doctors.');
  });
});

describe('upload sharing', () => {
  it('ticks every folder doctor on the documents page, only the appointment doctor from an appointment', () => {
    expect(defaultFolderTicks(['a', 'b'], null)).toEqual({ a: true, b: true });
    expect(defaultFolderTicks(['a', 'b'], 'b')).toEqual({ a: false, b: true });
    // A paused folder holder is never ticked for the patient.
    expect(defaultFolderTicks(['a', 'b'], null, ['b'])).toEqual({ a: true, b: false });
    expect(defaultFolderTicks(['a', 'b'], 'b', ['b'])).toEqual({ a: false, b: false });
  });

  it('sends the consultation with the upload only for an "after" end', () => {
    const opts = uploadShareOptions({
      mode: 'share',
      doctorIds: ['sp-1'],
      duration: '7d',
      untilDate: '',
      appointmentId: 'ap-1',
      batchId: 'batch-3',
      folderDoctorIds: [],
      folderTicks: {},
      surface: 'appointment_details',
    });
    expect(opts.appointment_id).toBeUndefined();
    expect(opts.duration).toBe('7d');
  });

  it('maps unticked folder doctors to exclusions and keeps one batch key', () => {
    const opts = uploadShareOptions({
      mode: 'share',
      doctorIds: ['sp-1'],
      duration: 'after_24h',
      untilDate: '',
      appointmentId: 'ap-1',
      batchId: 'batch-1',
      folderDoctorIds: ['sp-1', 'sp-2', 'sp-3'],
      folderTicks: { 'sp-2': true, 'sp-3': false },
      surface: 'appointment_details',
    });
    expect(opts).toEqual({
      specialist_ids: ['sp-1'],
      exclude_specialist_ids: ['sp-3'],
      surface: 'appointment_details',
      duration: 'after_24h',
      batch_id: 'batch-1',
      appointment_id: 'ap-1',
    });
    const privately = uploadShareOptions({
      mode: 'private',
      doctorIds: ['sp-1'],
      duration: '7d',
      untilDate: '',
      appointmentId: null,
      batchId: 'batch-2',
      folderDoctorIds: ['sp-2'],
      folderTicks: {},
      surface: 'documents_page',
    });
    expect(privately).toEqual({ specialist_ids: [], exclude_specialist_ids: ['sp-2'], surface: 'documents_page' });
  });

  it('says what happened from the responses', () => {
    type R = Pick<UploadedDocumentDto, 'shared_with' | 'share_outcome' | 'share_ended_for'>;
    const nameOf = (id: string) => (id === 'sp-3' ? 'Kemi Bello' : 'Someone');
    const sharedOne: R = { shared_with: [shared()], share_outcome: 'shared', share_ended_for: [] };
    expect(uploadOutcomeLines([sharedOne, sharedOne], nameOf, TZ)).toEqual(['Shared with Dr Bayo Ade until 30 Oct 2026.']);
    const folder: R = {
      shared_with: [shared({ specialist_id: 'sp-2', name: 'Ada Obi', via: 'folder' })],
      share_outcome: 'private',
      share_ended_for: [],
    };
    expect(uploadOutcomeLines([folder], nameOf)).toEqual(['Dr Ada Obi can also see it through your whole-folder share.']);
    const ended: R = { shared_with: [], share_outcome: 'share_ended', share_ended_for: ['sp-3'] };
    expect(uploadOutcomeLines([ended, ended], nameOf)).toEqual([
      "Saved, but your share with Dr Kemi Bello had already ended, so they can't see these files. You can share again from Manage sharing.",
    ]);
    expect(uploadOutcomeLines([{ shared_with: [], share_outcome: 'private', share_ended_for: [] }], nameOf)).toEqual([
      'Kept private — only you can see them.',
    ]);
    expect(uploadOutcomeLines([{ shared_with: [], share_outcome: 'sharing_unavailable', share_ended_for: [] }], nameOf)).toEqual([
      'Saved privately. Sharing is unavailable right now — you can share later.',
    ]);
  });
});

describe('booking step 5', () => {
  const holder = doctor('sp-1', 'Bayo Ade', { state: 'active', scope: 'all' });

  it('offers two cards, renamed when the booked doctor sees the whole folder', () => {
    expect(bookingShareCards('Bayo Ade', null)).toEqual({
      share: { label: 'Share with Dr Bayo Ade', hint: 'They can see these files.' },
      private: { label: 'Keep private', hint: 'Only you can see them. You can share later.' },
    });
    expect(bookingShareCards('Bayo Ade', holder).private).toEqual({
      label: "Don't share with Dr Bayo Ade",
      hint: 'Dr Bayo Ade can see your whole folder, but not these files.',
    });
  });

  it('requires a choice only once files are attached', () => {
    expect(bookingShareReady(0, null)).toBe(true);
    expect(bookingShareReady(2, null)).toBe(false);
    expect(bookingShareReady(2, 'private')).toBe(true);
  });

  it('sends the choice and the ticked folder doctors with attachments only', () => {
    expect(bookingDocumentShare(0, 'share', 'after_24h', ['sp-2'])).toBeUndefined();
    expect(bookingDocumentShare(1, 'private', 'after_7d', ['sp-2'])).toEqual({ duration: null, show_specialist_ids: ['sp-2'] });
    expect(bookingDocumentShare(1, 'share', 'after_7d', [])).toEqual({ duration: 'after_7d', show_specialist_ids: [] });
    expect(bookingDocumentShare(1, null, 'after_7d', [])).toEqual({ duration: null, show_specialist_ids: [] });
  });

  it('summarises the choice and lists other folder holders', () => {
    expect(bookingShareSummary('share', 'after_24h')).toBe('Until 24 hours after the consultation');
    expect(bookingShareSummary('share', 'indefinite')).toBe('No end date');
    expect(bookingShareSummary('private', 'after_24h')).toBe('Not shared');
    const list = [holder, doctor('sp-2', 'Ada Obi', { state: 'active', scope: 'all' }), doctor('sp-3', 'Kemi', { state: 'active', scope: 'selected' })];
    expect(otherFolderHolders(list, 'sp-1').map((d) => d.specialist.id)).toEqual(['sp-2']);
  });

  it('confirms a shared booking from the answer: who, and until when', () => {
    expect(bookedShareLine('Bayo Ade', '2026-10-29T16:30:00+01:00', TZ)).toBe(
      'Booked. Your files are shared with Dr Bayo Ade until 29 Oct 2026, 4:30 PM.',
    );
    expect(bookedShareLine('Bayo Ade', null, TZ)).toBe('Booked. Your files are shared with Dr Bayo Ade with no end date.');
    expect(bookedShareLine(null, null, TZ)).toBe('Booked. Your files are shared with your doctor with no end date.');
  });
});
