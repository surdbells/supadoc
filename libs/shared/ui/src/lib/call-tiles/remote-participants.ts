import { type CallUid, isCallRecorderUid } from './call-tiles.model';

/** What a client knows about one other person in the channel. */
export interface RemoteParticipant {
  readonly uid: CallUid;
  /** Publishing video that isn't muted. */
  readonly hasVideo: boolean;
  /** Publishing a microphone that isn't muted. */
  readonly hasAudio: boolean;
  /**
   * Talking in the latest volume report. Needs
   * `client.enableAudioVolumeIndicator()`; otherwise always `false`.
   */
  readonly speaking: boolean;
}

export type RemoteParticipantsChange =
  | { readonly type: 'joined' | 'updated' | 'left'; readonly uid: CallUid }
  | { readonly type: 'reset' };

export type RemoteParticipantsListener = (
  participants: readonly RemoteParticipant[],
  change: RemoteParticipantsChange,
) => void;

/**
 * The slice of Agora's `IAgoraRTCClient` that {@link RemoteParticipants.bind}
 * listens on — structural, so this library doesn't depend on the SDK.
 */
export interface CallEventSource {
  on(event: string, listener: (...args: never[]) => void): void;
  off(event: string, listener: (...args: never[]) => void): void;
}

interface RemoteUserLike {
  readonly uid: CallUid;
}

interface VolumeLevel {
  readonly uid: CallUid;
  readonly level: number;
}

interface Entry {
  uid: CallUid;
  audio: boolean;
  video: boolean;
  audioMuted: boolean;
  videoMuted: boolean;
  speaking: boolean;
}

/** Agora volume level (0–100) from which someone counts as talking. */
const SPEAKING_LEVEL = 5;

/**
 * Per-uid state of everyone else in an Agora call, built from the client's
 * events, so one participant turning their camera off (`user-unpublished`)
 * never touches anyone else's tile. Framework-free: listeners get an immutable
 * snapshot (join order) after every change — hand it to a signal.
 *
 * ```ts
 * const remotes = new RemoteParticipants((list) => this.remoteList.set(list));
 * const unbind = remotes.bind(client);   // before client.join(...)
 * // …on leave / before a rejoin: unbind(); remotes.clear();
 * ```
 *
 * It only keeps state: subscribing to tracks and playing them stays with the
 * client (see `CallTilesComponent` for the full wiring). Instead of `bind()`,
 * the event methods (`joined`, `published`, …) can be called from your own
 * handlers.
 */
export class RemoteParticipants {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<RemoteParticipantsListener>();
  private snapshot: readonly RemoteParticipant[] = [];

  constructor(listener?: RemoteParticipantsListener) {
    if (listener) this.listeners.add(listener);
  }

  /**
   * Listens to `user-joined`, `user-published`, `user-unpublished`,
   * `user-left`, `user-info-updated` and `volume-indicator` on an Agora
   * client. Returns a function that stops listening.
   */
  bind(client: CallEventSource): () => void {
    const handlers: [string, (...args: never[]) => void][] = [
      ['user-joined', (user: RemoteUserLike) => this.joined(user.uid)],
      ['user-published', (user: RemoteUserLike, kind: string) => this.published(user.uid, kind)],
      ['user-unpublished', (user: RemoteUserLike, kind: string) => this.unpublished(user.uid, kind)],
      ['user-left', (user: RemoteUserLike) => this.left(user.uid)],
      ['user-info-updated', (uid: CallUid, msg: string) => this.infoUpdated(uid, msg)],
      ['volume-indicator', (levels: readonly VolumeLevel[]) => this.volumes(levels)],
    ];
    for (const [event, fn] of handlers) client.on(event, fn);
    return () => {
      for (const [event, fn] of handlers) client.off(event, fn);
    };
  }

  /** Get told after every change; returns the unsubscribe function. */
  subscribe(listener: RemoteParticipantsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Everyone else in the channel, in join order. */
  list(): readonly RemoteParticipant[] {
    return this.snapshot;
  }

  get(uid: CallUid): RemoteParticipant | undefined {
    return this.snapshot.find((p) => String(p.uid) === String(uid));
  }

  has(uid: CallUid): boolean {
    return this.entries.has(String(uid));
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * `user-joined`: in the channel, possibly with camera and mic off. The cloud
   * recorder (`CALL_RECORDER_UID`) is not a participant and is ignored.
   */
  joined(uid: CallUid): void {
    if (isCallRecorderUid(uid) || this.entries.has(String(uid))) return;
    this.entry(uid);
    this.emit({ type: 'joined', uid });
  }

  /** `user-published` (`datachannel` is ignored). A new publish is never muted. */
  published(uid: CallUid, kind: string): void {
    if ((kind !== 'audio' && kind !== 'video') || isCallRecorderUid(uid)) return;
    const isNew = !this.entries.has(String(uid));
    const e = this.entry(uid);
    const before = this.view(e);
    if (kind === 'video') {
      e.video = true;
      e.videoMuted = false;
    } else {
      e.audio = true;
      e.audioMuted = false;
    }
    if (isNew) this.emit({ type: 'joined', uid });
    else if (this.changed(before, e)) this.emit({ type: 'updated', uid });
  }

  /** `user-unpublished`: only that person's audio or video goes. */
  unpublished(uid: CallUid, kind: string): void {
    const e = this.entries.get(String(uid));
    if (!e || (kind !== 'audio' && kind !== 'video')) return;
    const before = this.view(e);
    if (kind === 'video') e.video = false;
    else {
      e.audio = false;
      e.speaking = false;
    }
    if (this.changed(before, e)) this.emit({ type: 'updated', uid });
  }

  /** `user-info-updated`: mute / unmute without unpublishing. */
  infoUpdated(uid: CallUid, msg: string): void {
    const e = this.entries.get(String(uid));
    if (!e) return;
    const before = this.view(e);
    switch (msg) {
      case 'mute-audio':
        e.audioMuted = true;
        e.speaking = false;
        break;
      case 'unmute-audio':
        e.audioMuted = false;
        break;
      case 'mute-video':
      case 'disable-local-video':
        e.videoMuted = true;
        break;
      case 'unmute-video':
      case 'enable-local-video':
        e.videoMuted = false;
        break;
      default:
        return;
    }
    if (this.changed(before, e)) this.emit({ type: 'updated', uid });
  }

  /** `user-left` (quit, timed out or removed). */
  left(uid: CallUid): void {
    if (!this.entries.delete(String(uid))) return;
    this.emit({ type: 'left', uid });
  }

  /**
   * `volume-indicator` (every ~2 s once enabled). Unknown uids — the local
   * user is reported too — are ignored; anyone not reported has gone quiet.
   */
  volumes(levels: readonly VolumeLevel[]): void {
    const loud = new Set(levels.filter((l) => l.level >= SPEAKING_LEVEL).map((l) => String(l.uid)));
    for (const [key, e] of this.entries) {
      const speaking = loud.has(key) && e.audio && !e.audioMuted;
      if (speaking === e.speaking) continue;
      e.speaking = speaking;
      this.emit({ type: 'updated', uid: e.uid });
    }
  }

  /** Forget everyone (leaving, or before a rejoin). */
  clear(): void {
    if (!this.entries.size) return;
    this.entries.clear();
    this.emit({ type: 'reset' });
  }

  private entry(uid: CallUid): Entry {
    const key = String(uid);
    let e = this.entries.get(key);
    if (!e) {
      e = { uid, audio: false, video: false, audioMuted: false, videoMuted: false, speaking: false };
      this.entries.set(key, e);
    }
    return e;
  }

  private view(e: Entry): RemoteParticipant {
    return {
      uid: e.uid,
      hasVideo: e.video && !e.videoMuted,
      hasAudio: e.audio && !e.audioMuted,
      speaking: e.speaking,
    };
  }

  private changed(before: RemoteParticipant, e: Entry): boolean {
    const after = this.view(e);
    return (
      before.hasVideo !== after.hasVideo ||
      before.hasAudio !== after.hasAudio ||
      before.speaking !== after.speaking
    );
  }

  private emit(change: RemoteParticipantsChange): void {
    this.snapshot = Array.from(this.entries.values(), (e) => this.view(e));
    for (const listener of this.listeners) listener(this.snapshot, change);
  }
}
