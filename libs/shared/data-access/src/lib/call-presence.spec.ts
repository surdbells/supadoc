import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import type { CallPresenceMap, SuccessResponse } from '@supadoc/models';
import type { ApiRequestOptions } from './api.service';
import { CALL_PRESENCE_POLL_MS, injectCallPresence, sendCallPresence } from './call-presence';

/** Answer the next fetch with `status` and this JSON body. */
function answer(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })),
  );
}

/** One "in" beat; resolves with what the handlers were given once its answer is read. */
async function beat(): Promise<{ refused: unknown[] | null; beats: number }> {
  const seen: { refused: unknown[] | null; beats: number } = { refused: null, beats: 0 };
  sendCallPresence('https://api.test/api/public/call/t/presence', 'in', {}, {
    onBeat: () => seen.beats++,
    onRefused: (...args) => (seen.refused = args),
  });
  await new Promise((r) => setTimeout(r, 0));
  return seen;
}

describe('sendCallPresence', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hands a cancelled / ended consultation to the caller', async () => {
    answer(410, { message: 'Validation failed', errors: { call: 'This consultation was cancelled.', code: 'cancelled' } });
    expect((await beat()).refused).toEqual([410, 'cancelled', 'This consultation was cancelled.']);
  });

  it('hands a doctor refused for their standing (403) to the caller too', async () => {
    answer(403, { message: 'Refused', errors: { call: 'Your VideoMed account is suspended.', code: 'doctor_suspended' } });
    expect((await beat()).refused).toEqual([403, 'doctor_suspended', 'Your VideoMed account is suspended.']);
  });

  it('keeps any other 403 to itself — presence must never disturb the call', async () => {
    answer(403, { message: 'Refused', errors: { call: 'Please accept the notice', code: 'consent_required' } });
    expect((await beat()).refused).toBeNull();
  });

  it('reads an accepted beat', async () => {
    answer(200, { data: { presence: { doctor: true, patient: false, guests: [] }, participants: [] } });
    expect(await beat()).toEqual({ refused: null, beats: 1 });
  });

  describe('a signed-in beat is passive (never activity)', () => {
    /** The headers of each fetch made. */
    function sentHeaders(): Array<Record<string, string> | undefined> {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      return fetchMock.mock.calls.map((c) => (c[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined);
    }

    it('"in" and "out" with a bearer token carry X-SD-Passive: 1 (and the token)', async () => {
      answer(200, {});
      sendCallPresence('https://api.test/api/portal/appointments/ap-1/presence', 'in', { Authorization: 'Bearer t' });
      sendCallPresence('https://api.test/api/portal/appointments/ap-1/presence', 'out', { Authorization: 'Bearer t' });
      await new Promise((r) => setTimeout(r, 0));
      const [inBeat, outBeat] = sentHeaders();
      expect(inBeat?.['X-SD-Passive']).toBe('1');
      expect(inBeat?.['Authorization']).toBe('Bearer t');
      expect(outBeat?.['X-SD-Passive']).toBe('1');
    });

    it('a public (token-in-the-path) beat gets no extra header: "out" stays a CORS-simple request', async () => {
      answer(200, {});
      sendCallPresence('https://api.test/api/public/call/t/presence', 'in');
      sendCallPresence('https://api.test/api/public/call/t/presence', 'out');
      await new Promise((r) => setTimeout(r, 0));
      const [inBeat, outBeat] = sentHeaders();
      expect(inBeat?.['X-SD-Passive']).toBeUndefined();
      expect(outBeat).toBeUndefined();
    });
  });
});

describe('injectCallPresence', () => {
  @Component({ template: '' })
  class Page {
    readonly calls: ApiRequestOptions[] = [];
    paused = false;
    readonly presence = injectCallPresence(
      {
        presence: (options) => {
          this.calls.push(options);
          return of({ status: 'success', message: 'OK', data: { 'ap-1': { doctor: true, patient: false, guests: [] } } } as SuccessResponse<CallPresenceMap>);
        },
      },
      { paused: () => this.paused },
    );
  }

  let visibility: DocumentVisibilityState = 'visible';

  beforeAll(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  });
  afterAll(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });
  beforeEach(() => {
    visibility = 'visible';
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => vi.useRealTimers());

  it('every read — the first, each poll, back to a visible tab — is handed { passive: true }', () => {
    const fixture = TestBed.createComponent(Page);
    const page = fixture.componentInstance;
    expect(page.calls).toEqual([{ passive: true }]);
    expect(page.presence()['ap-1']?.doctor).toBe(true);

    vi.advanceTimersByTime(CALL_PRESENCE_POLL_MS);
    expect(page.calls.length).toBe(2);

    // Hidden: the poll skips its turn; becoming visible reads at once.
    visibility = 'hidden';
    vi.advanceTimersByTime(CALL_PRESENCE_POLL_MS);
    expect(page.calls.length).toBe(2);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(page.calls.length).toBe(3);

    expect(page.calls.every((o) => o.passive === true)).toBe(true);

    // Stops with the page.
    fixture.destroy();
    vi.advanceTimersByTime(3 * CALL_PRESENCE_POLL_MS);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(page.calls.length).toBe(3);
  });

  it('reads nothing while paused (the last known state stays), then resumes — still passive', () => {
    const fixture = TestBed.createComponent(Page);
    const page = fixture.componentInstance;
    expect(page.calls.length).toBe(1);

    page.paused = true;
    vi.advanceTimersByTime(2 * CALL_PRESENCE_POLL_MS);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(page.calls.length).toBe(1);
    expect(page.presence()['ap-1']?.doctor).toBe(true);

    page.paused = false;
    vi.advanceTimersByTime(CALL_PRESENCE_POLL_MS);
    expect(page.calls).toEqual([{ passive: true }, { passive: true }]);
    fixture.destroy();
  });
});
