import type { RemoteParticipant } from './remote-participants';

/** An Agora uid (numbers in this product; Agora also allows strings). */
export type CallUid = number | string;

/**
 * The cloud recorder's uid (the API's `AgoraRecordingService::RECORDER_UID`).
 * Not a person: it joins the channel while recording runs and never gets a
 * tile, so {@link RemoteParticipants} and {@link buildCallTiles} ignore it.
 */
export const CALL_RECORDER_UID = 525252;

/** Whether a uid is the cloud recorder rather than a participant. */
export function isCallRecorderUid(uid: CallUid): boolean {
  return String(uid) === String(CALL_RECORDER_UID);
}

export type CallTileRole = 'patient' | 'doctor' | 'guest';

/**
 * One person on the call stage. Names only — never emails or anything about
 * the visit.
 */
export interface CallTile {
  /**
   * The participant's Agora uid. The viewer's own tile can use its own uid or
   * any key that can't clash with a remote uid (e.g. `'self'`).
   */
  readonly uid: CallUid;
  readonly name: string;
  readonly role: CallTileRole;
  /** Video is playing — `false` shows the camera-off placeholder (initials). */
  readonly hasVideo: boolean;
  /** Microphone off or muted — shows the muted badge. */
  readonly muted: boolean;
  /** Currently talking — a green ring on grid tiles. */
  readonly speaking?: boolean;
  /** The viewer's own camera: the small self view 1:1, labelled "You". */
  readonly self?: boolean;
}

/**
 * `auto` (default): today's 1:1 stage — the other person big, the viewer's own
 * camera small — while at most one other person is there, an even grid from
 * the second. `grid`: always the grid.
 */
export type CallTilesLayout = 'auto' | 'grid';

/** What the stage is actually showing. */
export type CallTilesMode = 'spotlight' | 'grid';

/** The layout `<sd-call-tiles>` picks — for hosts that adapt their overlays to it. */
export function callTilesMode(
  tiles: readonly CallTile[],
  layout: CallTilesLayout = 'auto',
): CallTilesMode {
  if (layout === 'grid') return 'grid';
  return tiles.filter((t) => !t.self).length > 1 ? 'grid' : 'spotlight';
}

/** A named participant of the appointment, from the join payload's `participants`. */
export interface CallRosterEntry {
  readonly uid: CallUid;
  readonly role: string;
  readonly name: string;
}

/** The viewer's own tile, as {@link buildCallTiles} takes it. */
export interface CallSelfTile {
  /** Own Agora uid, or `'self'` when Agora assigned one (wildcard token). */
  readonly uid: CallUid;
  readonly role: CallTileRole;
  /** Used for the initials when the camera is off on the grid; labelled "You" anyway. */
  readonly name?: string;
  readonly hasVideo: boolean;
  readonly muted: boolean;
  readonly speaking?: boolean;
}

const ROLE_NAMES: Record<CallTileRole, string> = {
  patient: 'Patient',
  doctor: 'Doctor',
  guest: 'Guest',
};

/** Product uid convention: patient 1, doctor 2, guests from 100 (3–5 on older links). */
function roleForUid(uid: CallUid): CallTileRole {
  if (uid === 1 || uid === '1') return 'patient';
  if (uid === 2 || uid === '2') return 'doctor';
  return 'guest';
}

function asRole(role: string): CallTileRole {
  return role === 'patient' || role === 'doctor' ? role : 'guest';
}

/**
 * Turns who is connected ({@link RemoteParticipants}) plus the names from the
 * join payload into `<sd-call-tiles>` input. Only people actually in the call
 * get a tile; a uid the roster doesn't know yet (a guest added mid-call) gets
 * a role-based name ("Guest") until the roster is refreshed.
 *
 * Order: by `roleOrder` — default doctor, patient, guests; for a doctor viewer
 * the patient comes first — then roster order, then join order; the viewer's
 * own tile last.
 */
export function buildCallTiles(options: {
  remotes: readonly RemoteParticipant[];
  roster?: readonly CallRosterEntry[] | null;
  self?: CallSelfTile | null;
  roleOrder?: readonly CallTileRole[];
}): CallTile[] {
  const { remotes, roster, self } = options;
  const order: readonly CallTileRole[] =
    options.roleOrder ??
    (self?.role === 'doctor' ? ['patient', 'guest', 'doctor'] : ['doctor', 'patient', 'guest']);
  const rank = (role: CallTileRole) => {
    const i = order.indexOf(role);
    return i < 0 ? order.length : i;
  };
  const known = new Map<string, { entry: CallRosterEntry; index: number }>();
  (roster ?? []).forEach((entry, index) => known.set(String(entry.uid), { entry, index }));
  const selfKey = self ? String(self.uid) : null;

  const remoteTiles = remotes
    .filter((r) => String(r.uid) !== selfKey && !isCallRecorderUid(r.uid))
    .map((r, joinIndex) => {
      const hit = known.get(String(r.uid));
      const role = hit ? asRole(hit.entry.role) : roleForUid(r.uid);
      const tile: CallTile = {
        uid: r.uid,
        name: hit?.entry.name.trim() || ROLE_NAMES[role],
        role,
        hasVideo: r.hasVideo,
        muted: !r.hasAudio,
        speaking: r.speaking,
      };
      return { tile, rosterIndex: hit?.index ?? Number.MAX_SAFE_INTEGER, joinIndex };
    })
    .sort(
      (a, b) =>
        rank(a.tile.role) - rank(b.tile.role) ||
        a.rosterIndex - b.rosterIndex ||
        a.joinIndex - b.joinIndex,
    )
    .map((t) => t.tile);

  if (!self) return remoteTiles;
  return [
    ...remoteTiles,
    {
      uid: self.uid,
      name: self.name?.trim() || 'You',
      role: self.role,
      hasVideo: self.hasVideo,
      muted: self.muted,
      speaking: self.speaking,
      self: true,
    },
  ];
}

/** Two-letter initials for the camera-off avatar ("Dr Ada Obi" → "AO"). */
export function callTileInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => w && !/^(dr|prof|mr|mrs|ms|miss|mx)\.?$/i.test(w));
  if (!words.length) return '?';
  const first = Array.from(words[0])[0] ?? '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}
