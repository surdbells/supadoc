/**
 * In-call "nudges": a tiny Agora data-stream message telling the other side to
 * re-read something over the authenticated API. Every participant receives a
 * stream message — guests included — so a nudge NEVER carries an id, a title
 * or a name: the payload is exactly the ASCII string `sd:v1:<kind>` (e.g.
 * `sd:v1:docs`, 10 bytes). It only speeds things up; the receiver still polls,
 * so a nudge that is unsupported, throws or is lost costs nothing.
 *
 * `sendStreamMessage` and the `stream-message` event (`(uid, payload)`, 1 KB
 * limit) exist in agora-rtc-sdk-ng 4.20 but are not in its typings, hence the
 * structural client type.
 */

/** What changed: `docs` — the patient shared a document. */
export type CallNudgeKind = 'docs';

export const CALL_NUDGE_PREFIX = 'sd:v1:';
/** At most one nudge of a kind per client every 2 s (a later one is delayed, never dropped). */
export const CALL_NUDGE_MIN_INTERVAL_MS = 2_000;

const KINDS: readonly CallNudgeKind[] = ['docs'];
/** Longer payloads are someone else's messages: not even decoded. */
const MAX_PAYLOAD_BYTES = 64;

/** The parts of an Agora client a nudge uses (structural: missing from the SDK's typings). */
interface StreamMessenger {
  sendStreamMessage?: (payload: string | Uint8Array) => Promise<void>;
  on(event: string, cb: (...args: unknown[]) => void): void;
  off?(event: string, cb: (...args: unknown[]) => void): void;
}

interface NudgeState {
  lastSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Per client (weakly held, so a left call's client can go), per kind. */
const states = new WeakMap<object, Map<CallNudgeKind, NudgeState>>();

function isKind(value: unknown): value is CallNudgeKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

function stateFor(client: object, kind: CallNudgeKind): NudgeState {
  let perKind = states.get(client);
  if (!perKind) {
    perKind = new Map();
    states.set(client, perKind);
  }
  let state = perKind.get(kind);
  if (!state) {
    state = { lastSentAt: Number.NEGATIVE_INFINITY, timer: null };
    perKind.set(kind, state);
  }
  return state;
}

function transmit(client: StreamMessenger, kind: CallNudgeKind): void {
  try {
    const sent = client.sendStreamMessage?.(new TextEncoder().encode(CALL_NUDGE_PREFIX + kind));
    // A rejection (not joined yet, rate-limited) is fine: the receiver polls anyway.
    (sent as Promise<void> | undefined)?.catch?.(() => undefined);
  } catch {
    // Not joined: the SDK throws synchronously. Ignored for the same reason.
  }
}

/**
 * Tell everyone in the call that `kind` changed. Fire-and-forget: never
 * throws, and does nothing when the client can't send (unsupported, not
 * joined). Coalesced per client and kind: with no send in the last 2 s it
 * sends now; otherwise exactly one trailing send is scheduled for 2 s after
 * the last one, and further calls meanwhile are absorbed by it.
 */
export function sendCallNudge(client: unknown, kind: CallNudgeKind): void {
  if (!client || typeof client !== 'object' || !isKind(kind)) return;
  const messenger = client as StreamMessenger;
  const state = stateFor(client, kind);
  if (state.timer !== null) return; // the scheduled send covers this call
  const now = Date.now();
  if (now - state.lastSentAt >= CALL_NUDGE_MIN_INTERVAL_MS) {
    state.lastSentAt = now;
    transmit(messenger, kind);
    return;
  }
  state.timer = setTimeout(() => {
    state.timer = null;
    state.lastSentAt = Date.now();
    transmit(messenger, kind);
  }, state.lastSentAt + CALL_NUDGE_MIN_INTERVAL_MS - now);
}

/** The nudge kind a stream message carries, or null when it isn't exactly one of ours. */
function decodeNudge(payload: unknown): CallNudgeKind | null {
  let text: string;
  try {
    // isView / the tag rather than instanceof: the bytes may come from another realm.
    let bytes: Uint8Array;
    if (typeof payload === 'string') {
      text = payload;
    } else if (ArrayBuffer.isView(payload)) {
      bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
      if (bytes.byteLength > MAX_PAYLOAD_BYTES) return null;
      text = new TextDecoder().decode(bytes);
    } else if (Object.prototype.toString.call(payload) === '[object ArrayBuffer]') {
      bytes = new Uint8Array(payload as ArrayBuffer);
      if (bytes.byteLength > MAX_PAYLOAD_BYTES) return null;
      text = new TextDecoder().decode(bytes);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (text.length > MAX_PAYLOAD_BYTES || !text.startsWith(CALL_NUDGE_PREFIX)) return null;
  const kind = text.slice(CALL_NUDGE_PREFIX.length);
  return isKind(kind) ? kind : null;
}

/**
 * Listen for nudges on a client: `handler(kind, senderUid)` runs only for an
 * exact `sd:v1:<kind>` of a known kind (anything else on the data stream is
 * ignored). Check the sender before acting on it. Returns the unsubscribe
 * function; a client without events gives a no-op one.
 */
export function onCallNudge(
  client: unknown,
  handler: (kind: CallNudgeKind, uid: number | string) => void,
): () => void {
  const messenger = client as StreamMessenger | null;
  if (!messenger || typeof messenger !== 'object' || typeof messenger.on !== 'function') return () => undefined;
  const listener = (...args: unknown[]): void => {
    const [uid, payload] = args;
    if (typeof uid !== 'number' && typeof uid !== 'string') return;
    const kind = decodeNudge(payload);
    if (kind) handler(kind, uid);
  };
  messenger.on('stream-message', listener);
  return () => {
    try {
      messenger.off?.('stream-message', listener);
    } catch {
      // A torn-down client: nothing left to unsubscribe from.
    }
  };
}
