import { Injectable } from '@angular/core';

/** The SOAP fields of a consultation note. */
export interface NoteDraftPayload {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

interface StoredDraft {
  sub: string;
  savedAt: number;
  payload: NoteDraftPayload;
}

/** A note kept on this device, and when it was kept (this device's clock, epoch ms). */
export interface KeptNoteDraft {
  payload: NoteDraftPayload;
  savedAt: number;
}

/**
 * Whether a note kept on this device is newer than the note on the account
 * (its `updated_at`; null when it was never saved), so it may be put back and
 * saved over it. A note saved after the draft was kept — e.g. edited on
 * another device — wins: the device copy never overwrites a newer clinical
 * record. `clockOffsetMs` (this device's clock minus the server's) puts the
 * two times on one clock; when the server's time can't be read, the note on
 * the account is kept.
 */
export function draftIsNewer(
  draft: KeptNoteDraft,
  updatedAt: string | null | undefined,
  clockOffsetMs = 0,
): boolean {
  if (!updatedAt) return true;
  const serverAt = Date.parse(updatedAt);
  return !Number.isNaN(serverAt) && draft.savedAt - clockOffsetMs > serverAt;
}

const PREFIX = 'videomed.doctor.note-draft.';
/** A draft older than this is dropped (it is a stop-gap, never a second record). */
export const NOTE_DRAFT_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Consultation notes typed while the doctor's portal session has ended
 * (idle, expiry, signed out elsewhere — e.g. mid-call): kept on this device,
 * per appointment and per doctor (the token's `sub`), until they are saved to
 * the account after signing in again. Another doctor signing in on the same
 * device never sees them; a draft over a day old is dropped.
 */
@Injectable({ providedIn: 'root' })
export class NoteDraftStore {
  /** Keep this draft on the device. False when storage is unavailable (nothing kept). */
  save(appointmentId: string, sub: string, payload: NoteDraftPayload): boolean {
    if (!appointmentId || !sub) return false;
    const draft: StoredDraft = {
      sub,
      savedAt: Date.now(),
      payload: { ...payload },
    };
    try {
      localStorage.setItem(PREFIX + appointmentId, JSON.stringify(draft));
      return true;
    } catch {
      return false;
    }
  }

  /** The draft kept for this appointment by this doctor (and when), or null (another doctor's, too old, none). */
  take(appointmentId: string, sub: string | null): KeptNoteDraft | null {
    const draft = this.read(appointmentId);
    if (!draft || !sub || draft.sub !== sub) return null;
    return { payload: draft.payload, savedAt: draft.savedAt };
  }

  /** Forget the draft (it was saved to the account, or the note was finalized). */
  clear(appointmentId: string): void {
    try {
      localStorage.removeItem(PREFIX + appointmentId);
    } catch {
      /* no-op */
    }
  }

  /** How many drafts this doctor still has on the device, waiting to be saved to their account. */
  pendingCount(sub: string | null): number {
    if (!sub) return 0;
    const ids: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(PREFIX)) ids.push(key.slice(PREFIX.length));
      }
    } catch {
      return 0;
    }
    // Read after listing: a stale draft is removed as it is read.
    return ids.filter((id) => this.read(id)?.sub === sub).length;
  }

  private read(appointmentId: string): StoredDraft | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(PREFIX + appointmentId);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const draft = JSON.parse(raw) as StoredDraft;
      const p = draft?.payload;
      const valid =
        typeof draft?.sub === 'string' &&
        typeof draft.savedAt === 'number' &&
        !!p &&
        ['subjective', 'objective', 'assessment', 'plan'].every(
          (k) =>
            typeof (p as unknown as Record<string, unknown>)[k] === 'string',
        );
      if (!valid || Date.now() - draft.savedAt > NOTE_DRAFT_MAX_AGE_MS) {
        this.clear(appointmentId);
        return null;
      }
      return draft;
    } catch {
      this.clear(appointmentId);
      return null;
    }
  }
}
