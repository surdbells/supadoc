/**
 * When the doctor's call screen holds the portal idle timeout off (and, with
 * it, keeps the access token refreshed ahead even in a hidden tab — see
 * `SessionTimeoutService.hold`). Mirrors the patient's call screen: only while
 * a consultation is actually going on, so an ended call left open on a shared
 * computer still times out.
 */
export interface CallHoldState {
  /** Connected to the call, and the API still takes it (not closed / cancelled). */
  live: boolean;
  /** How many other people (patient, guests) are in the channel now. */
  othersInCall: number;
  /** Someone else has been in the call at some point. */
  someoneJoined: boolean;
  /** The bounded wait for the patient to first arrive has run out. */
  firstWaitOver: boolean;
}

/** Waiting for the patient to first arrive holds the idle timeout off for at most this long. */
export const FIRST_WAIT_HOLD_MS = 30 * 60_000;

/** Hold while connected and someone else is here, or while first waiting for them (bounded). */
export function callHoldWanted(s: CallHoldState): boolean {
  if (!s.live) return false;
  if (s.othersInCall > 0) return true;
  return !s.someoneJoined && !s.firstWaitOver;
}
