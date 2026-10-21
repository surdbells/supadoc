import { NETWORK_ERROR_MESSAGE } from '@supadoc/data-access';
import type { DoctorAccessRequestDto, DoctorDocumentAccessDto, DoctorSharedDocumentDto } from '@supadoc/models';
import {
  ACTIVE_WINDOW_MS,
  accessBanner,
  callEmptyCopy,
  callHeaderLine,
  isStaleRequestCode,
  LOAD_FAILED,
  MAX_REFRESH_MS,
  nextRefreshDelay,
  NOT_SHARED,
  OPEN_FAILED,
  openErrorCopy,
  requestDialogTitle,
  requestErrorCopy,
  sharedUntilText,
  shouldBackgroundPoll,
  unavailableBanner,
  untilLabel,
  VIEW_UNAVAILABLE,
} from './document-access';

const UTC = 'UTC';
/** ICU puts a narrow no-break space (U+202F, or U+00A0) before AM/PM; compare with plain spaces. */
const ODD_SPACES = new RegExp(`[${String.fromCharCode(0x202f, 0xa0)}]`, 'g');
const norm = (s: string | null | undefined) => (s ?? '').replace(ODD_SPACES, ' ');

interface Over {
  access?: Partial<DoctorDocumentAccessDto['access']>;
  request?: Partial<DoctorDocumentAccessDto['request']>;
  documents?: DoctorSharedDocumentDto[];
}

function dto(over: Over = {}): DoctorDocumentAccessDto {
  return {
    access: {
      state: 'none',
      scope: null,
      document_count: 0,
      until: null,
      until_label_at: null,
      indefinite: false,
      folder_until_label_at: null,
      folder_indefinite: false,
      next_change_at: null,
      ends_soon: false,
      had_access_before: false,
      ...over.access,
    },
    documents: over.documents ?? [],
    request: {
      can_request: true,
      kind: 'access',
      blocked_reason: null,
      available_at: null,
      pending: null,
      last: null,
      ...over.request,
    },
    server_time: '2026-10-21T10:00:00Z',
  };
}

function req(over: Partial<DoctorAccessRequestDto> = {}): DoctorAccessRequestDto {
  return {
    id: 'rq-1',
    kind: 'access',
    status: 'pending',
    message: null,
    appointment_id: 'ap-1',
    created_at: '2026-10-21T09:00:00Z',
    expires_at: '2026-10-28T09:00:00Z',
    decided_at: null,
    ...over,
  };
}

describe('accessBanner (doctor › Documents)', () => {
  it('nothing shared: says so, and offers Request access', () => {
    const b = accessBanner(dto(), 'Ada Obi', UTC);
    expect(b.access).toEqual({
      state: 'none',
      icon: 'lock',
      tone: 'neutral',
      title: 'No documents shared',
      body: "Ada Obi hasn't shared any documents with you. Patients choose what you can see and for how long.",
      detail: null,
      action: { kind: 'request', label: 'Request access', icon: 'key-round' },
    });
    expect(b.request).toBeNull();
    expect(b.requestKind).toBe('access');
  });

  it('nothing shared any more (had access before)', () => {
    const b = accessBanner(dto({ access: { had_access_before: true } }), 'Ada Obi', UTC);
    expect(b.access.body).toBe("Ada Obi isn't sharing any documents with you at the moment.");
  });

  it('no Request access button when the API says a request cannot be made', () => {
    const b = accessBanner(dto({ request: { can_request: false } }), 'Ada Obi', UTC);
    expect(b.access.action).toBeNull();
  });

  it('whole folder, no end date', () => {
    const b = accessBanner(
      dto({ access: { state: 'active', scope: 'all', indefinite: true, folder_indefinite: true, document_count: 4 }, request: { can_request: false, blocked_reason: 'has_full_access' } }),
      'Ada Obi',
      UTC,
    );
    expect(b.access.state).toBe('active_all');
    expect(b.access.icon).toBe('shield-check');
    expect(b.access.tone).toBe('success');
    expect(b.access.body).toBe('Ada Obi is sharing all their documents with you.');
    expect(b.access.detail).toBe('No end date set by the patient.');
    expect(b.access.action).toBeNull();
    // has_full_access: nothing to ask for, no request line.
    expect(b.request).toBeNull();
  });

  it('whole folder until a date: the last day only (its label is 23:59), or a date and time', () => {
    const day = accessBanner(
      dto({ access: { state: 'active', scope: 'all', until: '2026-10-31T00:00:00Z', until_label_at: '2026-10-30T23:59:59Z', folder_until_label_at: '2026-10-30T23:59:59Z' } }),
      'Ada Obi',
      UTC,
    );
    expect(day.access.detail).toBe('Access until 30 Oct 2026');
    const timed = accessBanner(
      dto({ access: { state: 'active', scope: 'all', until: '2026-10-30T16:30:00Z', until_label_at: '2026-10-30T16:30:00Z', folder_until_label_at: '2026-10-30T16:30:00Z' } }),
      'Ada Obi',
      UTC,
    );
    expect(norm(timed.access.detail)).toBe('Access until 30 Oct 2026, 4:30 PM');
  });

  it('whole folder ending within 48 h: Access ends … and Ask to extend', () => {
    const b = accessBanner(
      dto({
        access: { state: 'active', scope: 'all', ends_soon: true, until_label_at: '2026-10-22T09:00:00Z', folder_until_label_at: '2026-10-22T09:00:00Z', next_change_at: '2026-10-22T09:00:00Z' },
        request: { can_request: true, kind: 'extend' },
      }),
      'Ada Obi',
      UTC,
    );
    expect(b.access.state).toBe('ends_soon');
    expect(b.access.icon).toBe('hourglass');
    expect(b.access.tone).toBe('warning');
    expect(norm(b.access.detail)).toBe('Access ends 22 Oct 2026, 9:00 AM.');
    expect(b.access.action).toEqual({ kind: 'extend', label: 'Ask to extend', icon: 'key-round' });
    expect(b.requestKind).toBe('extend');
  });

  // A folder share until 30 Oct plus one document shared with no end date:
  // the overall end is "no end date" (NULL wins), but the folder — and so
  // new uploads — stops on 30 Oct. The banner tells the folder's own end.
  it("whole folder plus a document with no end date: the folder's own end, not 'No end date'", () => {
    const b = accessBanner(
      dto({
        access: {
          state: 'active',
          scope: 'all',
          document_count: 5,
          until: null,
          until_label_at: null,
          indefinite: true,
          folder_until_label_at: '2026-10-30T23:59:59Z',
          folder_indefinite: false,
        },
      }),
      'Ada Obi',
      UTC,
    );
    expect(b.access.state).toBe('active_all');
    expect(b.access.detail).toBe('Access until 30 Oct 2026');
  });

  it('whole folder ending soon plus a document with no end date: Access ends {folder end}', () => {
    const b = accessBanner(
      dto({
        access: {
          state: 'active',
          scope: 'all',
          ends_soon: true,
          until_label_at: null,
          indefinite: true,
          folder_until_label_at: '2026-10-22T09:00:00Z',
          folder_indefinite: false,
          next_change_at: '2026-10-22T09:00:00Z',
        },
        request: { can_request: true, kind: 'extend' },
      }),
      'Ada Obi',
      UTC,
    );
    expect(b.access.state).toBe('ends_soon');
    expect(norm(b.access.detail)).toBe('Access ends 22 Oct 2026, 9:00 AM.');
  });

  it('a folder share with no end date reads "No end date" even when a document share ends sooner', () => {
    const b = accessBanner(
      dto({
        access: {
          state: 'active',
          scope: 'all',
          until_label_at: null,
          indefinite: true,
          folder_until_label_at: null,
          folder_indefinite: true,
        },
      }),
      'Ada Obi',
      UTC,
    );
    expect(b.access.detail).toBe('No end date set by the patient.');
  });

  it('some documents: the count, until when, and Ask for more', () => {
    const one = accessBanner(
      dto({ access: { state: 'active', scope: 'selected', document_count: 1, until_label_at: '2026-10-28T09:00:00Z' } }),
      'Ada Obi',
      UTC,
    );
    expect(one.access.state).toBe('active_selected');
    expect(one.access.body).toBe('Ada Obi is sharing 1 document with you.');
    expect(norm(one.access.detail)).toBe('Access until 28 Oct 2026, 9:00 AM');
    expect(one.access.action).toEqual({ kind: 'more', label: 'Ask for more', icon: 'key-round' });

    const three = accessBanner(
      dto({ access: { state: 'active', scope: 'selected', document_count: 3, indefinite: true }, request: { can_request: false } }),
      'Ada Obi',
      UTC,
    );
    expect(three.access.body).toBe('Ada Obi is sharing 3 documents with you.');
    expect(three.access.detail).toBe('No end date set by the patient.');
    expect(three.access.action).toBeNull();
  });

  it('request waiting: when it was sent, when it closes, and Withdraw (no second request button)', () => {
    const b = accessBanner(
      dto({ request: { can_request: false, blocked_reason: 'request_pending', pending: req() } }),
      'Ada Obi',
      UTC,
    );
    expect(b.request).toEqual({
      state: 'pending',
      icon: 'hourglass',
      tone: 'warning',
      text: 'Request sent 21 Oct 2026. Waiting for Ada Obi to answer — it closes on 28 Oct 2026.',
      action: { kind: 'withdraw', label: 'Withdraw request', icon: 'undo-2' },
    });
    expect(b.access.action).toBeNull();
  });

  it('declined lately: when, and when they can ask again', () => {
    const b = accessBanner(
      dto({
        request: {
          can_request: false,
          blocked_reason: 'request_cooldown',
          available_at: '2026-10-23T09:00:00Z',
          last: req({ status: 'declined', decided_at: '2026-10-20T09:00:00Z' }),
        },
      }),
      'Ada Obi',
      UTC,
    );
    expect(b.request?.state).toBe('cooldown');
    expect(b.request?.icon).toBe('clock');
    expect(norm(b.request?.text)).toBe('Ada Obi declined your request on 20 Oct 2026. You can ask again after 23 Oct 2026, 9:00 AM.');
    expect(b.request?.action).toBeNull();
    expect(b.access.action).toBeNull();
  });

  it('request limit reached', () => {
    const b = accessBanner(
      dto({ request: { can_request: false, blocked_reason: 'request_limit', available_at: '2026-10-22T18:15:00Z' } }),
      'Ada Obi',
      UTC,
    );
    expect(b.request?.state).toBe('limit');
    expect(norm(b.request?.text)).toBe("You've reached the limit of access requests for now. You can ask again after 22 Oct 2026, 6:15 PM.");
  });

  it('blocked by the patient: neutral words', () => {
    const b = accessBanner(dto({ request: { can_request: false, blocked_reason: 'request_blocked' } }), 'Ada Obi', UTC);
    expect(b.request).toEqual({ state: 'blocked', icon: 'info', tone: 'info', text: "You can't ask this patient right now.", action: null });
    expect(b.access.state).toBe('none');
    expect(b.access.action).toBeNull();
  });

  it('a consultation that cannot ask (too old, cancelled…)', () => {
    const b = accessBanner(dto({ request: { can_request: false, blocked_reason: 'appointment_not_eligible' } }), 'Ada Obi', UTC);
    expect(b.request?.state).toBe('not_eligible');
    expect(b.request?.text).toBe('You can ask for access from an upcoming consultation or one in the last 30 days.');
  });

  it('sharing unavailable reads like a failed load, with Try again', () => {
    const b = accessBanner(
      dto({ access: { state: 'none' }, request: { can_request: false, blocked_reason: 'sharing_unavailable' } }),
      'Ada Obi',
      UTC,
    );
    expect(b).toEqual(unavailableBanner());
    expect(b.access).toEqual({
      state: 'unavailable',
      icon: 'triangle-alert',
      tone: 'error',
      title: null,
      body: LOAD_FAILED,
      detail: null,
      action: { kind: 'retry', label: 'Try again', icon: 'refresh-cw' },
    });
  });

  it('without a name yet: "The patient…" / "…for the patient to answer"', () => {
    expect(accessBanner(dto(), '  ', UTC).access.body).toMatch(/^The patient hasn't shared/);
    const pending = accessBanner(dto({ request: { can_request: false, pending: req() } }), null, UTC);
    expect(pending.request?.text).toContain('Waiting for the patient to answer');
  });
});

describe('dates', () => {
  it('untilLabel: no end, end of a day, midnight, a time', () => {
    expect(untilLabel(null, true, UTC)).toBe('No end date');
    expect(untilLabel(null, false, UTC)).toBe('');
    expect(untilLabel('2026-10-30T23:59:59Z', false, UTC)).toBe('30 Oct 2026');
    expect(untilLabel('2026-10-31T00:00:00Z', false, UTC)).toBe('31 Oct 2026');
    expect(norm(untilLabel('2026-10-30T08:05:00Z', false, UTC))).toBe('30 Oct 2026, 8:05 AM');
  });

  it("untilLabel reads the label on the viewer's clock", () => {
    // 22:59:59 UTC is 23:59:59 in Lagos (UTC+1): the end of 30 Oct there.
    expect(untilLabel('2026-10-30T22:59:59Z', false, 'Africa/Lagos')).toBe('30 Oct 2026');
  });

  it('sharedUntilText for a list row', () => {
    expect(sharedUntilText({ shared_until_label_at: null, shared_indefinitely: true }, UTC)).toBe('No end date');
    expect(sharedUntilText({ shared_until_label_at: '2026-10-30T23:59:59Z', shared_indefinitely: false }, UTC)).toBe(
      'Shared until 30 Oct 2026',
    );
    expect(sharedUntilText({ shared_until_label_at: null, shared_indefinitely: false }, UTC)).toBe('');
  });
});

describe('refresh timing', () => {
  const now = Date.parse('2026-10-21T10:00:00Z');

  it('nextRefreshDelay: a second after the change, clamped to 1 s – 24 h', () => {
    expect(nextRefreshDelay(null, now)).toBeNull();
    expect(nextRefreshDelay('not a date', now)).toBeNull();
    expect(nextRefreshDelay('2026-10-21T10:10:00Z', now)).toBe(10 * 60_000 + 1_000);
    expect(nextRefreshDelay('2026-10-21T09:00:00Z', now)).toBe(1_000);
    expect(nextRefreshDelay('2026-10-25T10:00:00Z', now)).toBe(MAX_REFRESH_MS);
  });

  it('shouldBackgroundPoll: on screen and used in the last 5 minutes', () => {
    expect(shouldBackgroundPoll(true, now - (ACTIVE_WINDOW_MS - 1_000), now)).toBe(true);
    expect(shouldBackgroundPoll(true, now - ACTIVE_WINDOW_MS, now)).toBe(false);
    expect(shouldBackgroundPoll(false, now, now)).toBe(false);
    expect(shouldBackgroundPoll(true, null, now)).toBe(false);
  });
});

describe('request copy', () => {
  it('requestDialogTitle', () => {
    expect(requestDialogTitle('access', 'Ada Obi')).toBe('Ask Ada Obi to share documents');
    expect(requestDialogTitle('extend', 'Ada Obi')).toBe('Ask Ada Obi to keep sharing');
    expect(requestDialogTitle('access', '')).toBe('Ask the patient to share documents');
  });

  it('requestErrorCopy: each refusal, with when to ask again', () => {
    expect(requestErrorCopy('request_pending', null)).toBe('You already have a request waiting for the patient to answer.');
    expect(norm(requestErrorCopy('request_cooldown', '2026-10-23T09:00:00Z', UTC))).toBe(
      'The patient declined your last request. You can ask again after 23 Oct 2026, 9:00 AM.',
    );
    expect(requestErrorCopy('request_cooldown', null)).toBe('The patient declined your last request. You can ask again later.');
    expect(norm(requestErrorCopy('request_limit', '2026-10-22T18:15:00Z', UTC))).toBe(
      "You've reached the limit of access requests for now. You can ask again after 22 Oct 2026, 6:15 PM.",
    );
    expect(requestErrorCopy('has_full_access', null)).toBe('The patient already shares all their documents with you.');
    expect(requestErrorCopy('request_blocked', null)).toBe("You can't ask this patient right now.");
    expect(requestErrorCopy('appointment_not_eligible', null)).toBe(
      'You can ask for access from an upcoming consultation or one in the last 30 days.',
    );
    expect(requestErrorCopy('request_not_pending', null)).toBe('This request was already answered or closed.');
    expect(requestErrorCopy('sharing_unavailable', null)).toContain('unavailable right now');
    expect(requestErrorCopy('doctor_unavailable', null)).toContain("isn't taking consultations");
    // Anything else (e.g. a `message` field error): the API's own words.
    expect(requestErrorCopy(null, null)).toBeNull();
    expect(requestErrorCopy('something_new', null)).toBeNull();
  });

  it('isStaleRequestCode: refusals that mean the page is out of date', () => {
    for (const code of ['request_pending', 'request_cooldown', 'request_limit', 'has_full_access', 'request_blocked', 'appointment_not_eligible', 'request_not_pending', 'sharing_unavailable']) {
      expect(isStaleRequestCode(code)).toBe(true);
    }
    expect(isStaleRequestCode(null)).toBe(false);
    expect(isStaleRequestCode('doctor_unavailable')).toBe(false);
  });

  it('openErrorCopy: no longer shared, not recorded, offline, anything else', () => {
    expect(openErrorCopy(404, 'not_shared')).toBe(NOT_SHARED);
    expect(NOT_SHARED).toBe('This document is no longer shared with you.');
    expect(openErrorCopy(503, 'view_unavailable')).toBe(VIEW_UNAVAILABLE);
    expect(VIEW_UNAVAILABLE).toBe('Could not open the document right now. Try again.');
    expect(openErrorCopy(0, null)).toBe(NETWORK_ERROR_MESSAGE);
    expect(openErrorCopy(500, null)).toBe(OPEN_FAILED);
  });
});

describe('call screen', () => {
  const now = Date.parse('2026-10-21T10:00:00Z');

  it('callHeaderLine: nothing shared / no end date / until a time today / until a day', () => {
    expect(callHeaderLine(dto(), now, UTC)).toBe('No documents shared');
    expect(callHeaderLine(dto({ access: { state: 'active', scope: 'all', indefinite: true, folder_indefinite: true } }), now, UTC)).toBe(
      'Shared by the patient · no end date',
    );
    expect(
      norm(callHeaderLine(dto({ access: { state: 'active', scope: 'selected', until_label_at: '2026-10-21T16:30:00Z' } }), now, UTC)),
    ).toBe('Shared by the patient · until 4:30 PM');
    expect(
      callHeaderLine(dto({ access: { state: 'active', scope: 'all', until_label_at: '2026-10-30T23:59:59Z', folder_until_label_at: '2026-10-30T23:59:59Z' } }), now, UTC),
    ).toBe('Shared by the patient · until 30 Oct 2026');
  });

  it("callHeaderLine with a whole-folder share uses the folder's own end", () => {
    // Folder until 30 Oct + a document with no end date: not "· no end date".
    expect(
      callHeaderLine(
        dto({
          access: {
            state: 'active',
            scope: 'all',
            until_label_at: null,
            indefinite: true,
            folder_until_label_at: '2026-10-30T23:59:59Z',
            folder_indefinite: false,
          },
        }),
        now,
        UTC,
      ),
    ).toBe('Shared by the patient · until 30 Oct 2026');
    // Folder ending later today: the time only.
    expect(
      norm(
        callHeaderLine(
          dto({
            access: {
              state: 'active',
              scope: 'all',
              until_label_at: null,
              indefinite: true,
              folder_until_label_at: '2026-10-21T16:30:00Z',
              folder_indefinite: false,
            },
          }),
          now,
          UTC,
        ),
      ),
    ).toBe('Shared by the patient · until 4:30 PM');
  });

  it('callEmptyCopy per Records tab', () => {
    expect(callEmptyCopy('documents', 'none')).toEqual({
      title: 'No documents shared',
      body: "The patient hasn't shared any documents with you.",
    });
    expect(callEmptyCopy('documents', 'active').title).toBe('No documents yet');
    expect(callEmptyCopy('imaging', 'none')).toEqual({ title: 'No shared imaging.', body: null });
    expect(callEmptyCopy('labs', 'active')).toEqual({ title: 'No shared lab reports.', body: null });
  });
});
