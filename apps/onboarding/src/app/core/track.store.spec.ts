import { TestBed } from '@angular/core/testing';
import { HttpTestingController, ok, P, testProviders } from '../../testing/onb-testing';
import { ApplicantSession, TRACK_TOKEN_KEY } from './applicant-session';
import { TrackStore } from './track.store';

describe('TrackStore', () => {
  let store: TrackStore;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders() });
    store = TestBed.inject(TrackStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('starts a check, preselects the default channel, sends and verifies a code', async () => {
    const starting = store.start('GVM-DR-2026-12345', 'ada@example.com');
    const start = http.expectOne(`${P}/track/start`);
    expect(start.request.body).toEqual({ reference: 'GVM-DR-2026-12345', contact: 'ada@example.com' });
    expect(start.request.headers.has('Authorization')).toBe(false);
    start.flush(
      ok({
        track_id: 'trk',
        expires_in: 900,
        channels: [
          { channel: 'sms', destination: 'The phone number on your application', generic: true, default: false },
          { channel: 'email', destination: 'ada***@example.com', generic: false, default: true },
        ],
      }),
    );
    await starting;
    expect(store.chosen()).toBe('email');

    const sending = store.requestCode('sms');
    const req = http.expectOne(`${P}/track/request-code`);
    expect(req.request.body).toEqual({ track_id: 'trk', channel: 'sms' });
    req.flush(ok({ sent_to: 'The phone number on your application', expires_in: 600, resend_after: 60 }), { status: 202, statusText: 'Accepted' });
    expect((await sending).expires_in).toBe(600);
    expect(store.sentTo()).toBe('The phone number on your application');

    const verifying = store.verify('123456');
    const v = http.expectOne(`${P}/track/verify`);
    expect(v.request.body).toEqual({ track_id: 'trk', code: '123456' });
    v.flush(ok({ access_token: 'acc', expires_in: 1800 }));
    await verifying;
    expect(sessionStorage.getItem(TRACK_TOKEN_KEY)).toBe('acc');
    expect(store.hasAccess()).toBe(true);
    expect(store.trackId()).toBeNull();
  });

  it('holds a prefilled reference in memory, upper-cased', () => {
    store.prefill(' gvm-dr-2026-12345 ');
    expect(store.prefillReference()).toBe('GVM-DR-2026-12345');
    expect(Object.keys(sessionStorage)).toHaveLength(0);
  });

  it('signs out of the status session', () => {
    TestBed.inject(ApplicantSession).setAccessToken('acc');
    store.signOut();
    expect(store.hasAccess()).toBe(false);
  });
});
