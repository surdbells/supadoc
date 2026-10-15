import { apiErrorFields, apiErrorMessage, isDoctorStandingCode } from '@supadoc/data-access';
import type { CallRefusalCode, DoctorStandingCode } from '@supadoc/models';

/**
 * Pure helpers shared by the patient's call screens (the signed-in
 * consultation and the join-link page): saying clearly why a camera or
 * microphone failed, reading a refused join link, and the times they show.
 * The devices themselves are opened in `call-media.ts`.
 */

/** Why a camera or microphone couldn't be opened. */
export type DeviceProblem = 'denied' | 'missing' | 'busy' | 'failed';

/** Agora wraps the browser's DOMException; both names and codes are checked. */
export function deviceProblem(err: unknown): DeviceProblem {
  const e = (err && typeof err === 'object' ? err : {}) as { code?: unknown; name?: unknown; message?: unknown };
  const tag = `${String(e.code ?? '')} ${String(e.name ?? '')} ${String(e.message ?? '')}`;
  if (/PERMISSION_DENIED|NotAllowedError|SecurityError|permission denied/i.test(tag)) return 'denied';
  if (/NOT_READABLE|NotReadableError|TrackStartError|could not start/i.test(tag)) return 'busy';
  if (/DEVICE_NOT_FOUND|NotFoundError|OverconstrainedError|CONSTRAINT_NOT_SATISFIED|not found/i.test(tag)) return 'missing';
  return 'failed';
}

/** One plain sentence about a device problem, with what to do about it. */
export function deviceProblemText(device: 'camera' | 'microphone', problem: DeviceProblem): string {
  const It = device === 'camera' ? 'Camera' : 'Microphone';
  switch (problem) {
    case 'denied':
      return `${It} access is blocked. Allow it in your browser’s site settings (the icon beside the web address), then try again.`;
    case 'missing':
      return `No ${device} was found. Connect one and try again, or join without it.`;
    case 'busy':
      return `Your ${device} is being used by another app. Close that app (another video call, for example), then try again.`;
    default:
      return `Your ${device} couldn’t be started. Try again, or join without it.`;
  }
}

/**
 * A refused join link / heartbeat (see `CallRefusalCode`) — or, on a doctor's
 * link, a 403 for their standing (`DoctorStandingCode`, e.g. suspended mid-call).
 */
export interface CallRefusal {
  readonly status: number;
  readonly code: CallRefusalCode | DoctorStandingCode | null;
  /** The API's own words, ready to show. */
  readonly message: string;
  /** too_early: when joining opens, and the server's clock (for the countdown). */
  readonly opensAt: string | null;
  readonly serverTime: string | null;
}

/** The HTTP status of a thrown API error (either error shape), or 0. */
export function httpStatus(err: unknown): number {
  if (!err || typeof err !== 'object') return 0;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  return typeof e.status === 'number' ? e.status : 0;
}

/** The refusal in a failed join / lobby / consent call, or null for any other failure. */
export function callRefusal(err: unknown): CallRefusal | null {
  const status = httpStatus(err);
  const fields = apiErrorFields(err);
  const code = (fields['code'] ?? null) as CallRefusalCode | DoctorStandingCode | null;
  if (!code && status !== 410 && status !== 409 && status !== 425) return null;
  return {
    status,
    code,
    message: apiErrorMessage(err, 'This call can’t be joined right now.'),
    opensAt: fields['opens_at'] ?? null,
    serverTime: fields['server_time'] ?? null,
  };
}

/**
 * A refusal that means there is no call for this link (now, or at all): show a
 * final screen. A doctor refused for their standing (403) is final too.
 */
export function isFinalRefusal(r: { status: number; code: CallRefusalCode | DoctorStandingCode | null }): boolean {
  if (r.code === 'too_early' || r.code === 'consent_required') return false;
  if (isDoctorStandingCode(r.code)) return true;
  return r.status === 410 || r.status === 409 || r.code === 'cancelled' || r.code === 'ended' || r.code === 'withdrawn' || r.code === 'not_confirmed';
}

/** "Tuesday 14 October 2026, 3:00 pm GMT+1" — the viewer's local time, with its zone. */
export function callWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? ''
    : new Intl.DateTimeFormat('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short',
      }).format(d);
}

/** A countdown: "4:05", or "1 h 05 min" from an hour up, "2 days" from a day up. */
export function countdownLabel(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 86_400) {
    const days = Math.floor(s / 86_400);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h} h ${m.toString().padStart(2, '0')} min`;
  }
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

/** "Dr Ada Obi" — adds the title when the name doesn't carry one. */
export function doctorTitle(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (!n) return 'your doctor';
  return /^(dr|prof)\b/i.test(n) ? n : `Dr ${n}`;
}
