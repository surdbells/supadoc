import { CALL_NUDGE_MIN_INTERVAL_MS, CALL_NUDGE_PREFIX, onCallNudge, sendCallNudge } from './call-nudge';

type Listener = (...args: unknown[]) => void;

/** A stand-in for an Agora client: records what it sends, lets a test deliver stream messages. */
function fakeClient(send?: (payload: string | Uint8Array) => Promise<void>) {
  const listeners = new Map<string, Set<Listener>>();
  const sent: string[] = [];
  const client = {
    sendStreamMessage:
      send ??
      vi.fn(async (payload: string | Uint8Array) => {
        sent.push(typeof payload === 'string' ? payload : new TextDecoder().decode(payload));
      }),
    on: (event: string, cb: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(cb);
    },
    off: (event: string, cb: Listener) => listeners.get(event)?.delete(cb),
    deliver: (uid: number | string, payload: unknown) => {
      for (const cb of listeners.get('stream-message') ?? []) cb(uid, payload);
    },
    listenerCount: () => listeners.get('stream-message')?.size ?? 0,
  };
  return { client, sent };
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe('call nudges', () => {
  afterEach(() => vi.useRealTimers());

  it('sends exactly the 10 ASCII bytes "sd:v1:docs" — no id, title or name', () => {
    const { client } = fakeClient();
    sendCallNudge(client, 'docs');
    expect(client.sendStreamMessage).toHaveBeenCalledTimes(1);
    const payload = (client.sendStreamMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as Uint8Array;
    expect(ArrayBuffer.isView(payload)).toBe(true);
    expect(payload.byteLength).toBe(10);
    expect(new TextDecoder().decode(payload)).toBe(`${CALL_NUDGE_PREFIX}docs`);
  });

  it('decodes allowlisted nudges for the handler, with the sender uid, and ignores the rest', () => {
    const { client } = fakeClient();
    const seen: [string, number | string][] = [];
    const off = onCallNudge(client, (kind, uid) => seen.push([kind, uid]));

    client.deliver(1, bytes('sd:v1:docs'));
    client.deliver('7', 'sd:v1:docs');
    client.deliver(1, bytes('sd:v1:docs').buffer);
    client.deliver(1, bytes('sd:v1:chat'));
    client.deliver(1, bytes('sd:v2:docs'));
    client.deliver(1, bytes('sd:v1:docs:abc'));
    client.deliver(1, bytes('hello'));
    client.deliver(1, new Uint8Array(1024));
    client.deliver(1, { not: 'bytes' });
    client.deliver({ uid: 1 } as unknown as number, bytes('sd:v1:docs')); // not a uid

    expect(seen).toEqual([
      ['docs', 1],
      ['docs', '7'],
      ['docs', 1],
    ]);
    off();
    expect(client.listenerCount()).toBe(0);
    client.deliver(1, bytes('sd:v1:docs'));
    expect(seen).toHaveLength(3);
  });

  it('round-trips between two fake clients', () => {
    const a = fakeClient();
    const b = fakeClient();
    const seen: string[] = [];
    onCallNudge(b.client, (kind) => seen.push(kind));
    a.client.sendStreamMessage = vi.fn(async (payload: string | Uint8Array) => b.client.deliver(1, payload));
    sendCallNudge(a.client, 'docs');
    expect(seen).toEqual(['docs']);
  });

  it('never throws when sending is missing, throws synchronously or rejects', async () => {
    expect(() => sendCallNudge({ on: () => undefined }, 'docs')).not.toThrow();
    expect(() =>
      sendCallNudge(
        fakeClient(() => {
          throw new Error('not joined');
        }).client,
        'docs',
      ),
    ).not.toThrow();
    const rejecting = fakeClient(() => Promise.reject(new Error('rate limited'))).client;
    expect(() => sendCallNudge(rejecting, 'docs')).not.toThrow();
    await Promise.resolve(); // the rejection is handled (no unhandled-rejection failure)
    expect(() => sendCallNudge(null, 'docs')).not.toThrow();
    expect(() => sendCallNudge('client', 'docs')).not.toThrow();
    expect(onCallNudge(null, () => undefined)).toBeTypeOf('function');
    expect(() => onCallNudge({}, () => undefined)()).not.toThrow();
  });

  it('coalesces: 0, 0.5 and 1.5 s send at 0 and once more at 2 s; 5 s sends at once', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T15:00:00Z'));
    const { client, sent } = fakeClient();
    const send = client.sendStreamMessage as ReturnType<typeof vi.fn>;

    sendCallNudge(client, 'docs'); // t = 0
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    sendCallNudge(client, 'docs'); // t = 0.5 s: schedules the trailing send
    vi.advanceTimersByTime(1000);
    sendCallNudge(client, 'docs'); // t = 1.5 s: absorbed
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(499);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); // t = 2 s
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CALL_NUDGE_MIN_INTERVAL_MS * 5);
    expect(send).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-11-04T15:00:05Z'));
    sendCallNudge(client, 'docs'); // t = 5 s
    expect(send).toHaveBeenCalledTimes(3);
    expect(new Set(sent)).toEqual(new Set(['sd:v1:docs']));
  });

  it('keeps each client separate', () => {
    vi.useFakeTimers();
    const a = fakeClient().client;
    const b = fakeClient().client;
    sendCallNudge(a, 'docs');
    sendCallNudge(b, 'docs');
    expect(a.sendStreamMessage).toHaveBeenCalledTimes(1);
    expect(b.sendStreamMessage).toHaveBeenCalledTimes(1);
  });
});
