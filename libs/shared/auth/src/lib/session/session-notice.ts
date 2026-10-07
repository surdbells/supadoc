import type { SessionEndReason } from './session-auth';

/**
 * A one-shot note for the sign-in screen explaining why the user landed there
 * ("You were signed out after 15 minutes of inactivity…"). Held in
 * sessionStorage so it belongs to the tab that was signed out and survives the
 * redirect, and is cleared as soon as the sign-in screen reads it.
 */
const NOTICE_KEY = 'videomed.session.notice';

export const SESSION_END_MESSAGES: Record<SessionEndReason, string> = {
  idle: 'You were signed out because you were inactive for a while. This keeps your account and health information safe. Please sign in again.',
  expired: 'Your session has expired. Please sign in again.',
  revoked: 'This session was signed out. Please sign in again.',
  elsewhere: 'You were signed out in another tab or window. Please sign in again.',
};

export function setSessionNotice(reason: SessionEndReason, message?: string): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, message?.trim() || SESSION_END_MESSAGES[reason]);
  } catch {
    /* storage unavailable — the notice is best-effort */
  }
}

/** The pending notice without clearing it (used to tell involuntary sign-outs apart). */
export function peekSessionNotice(): string | null {
  try {
    return sessionStorage.getItem(NOTICE_KEY);
  } catch {
    return null;
  }
}

/** The pending notice, clearing it — call once from the sign-in screen. */
export function consumeSessionNotice(): string | null {
  const notice = peekSessionNotice();
  try {
    sessionStorage.removeItem(NOTICE_KEY);
  } catch {
    /* no-op */
  }
  return notice;
}
