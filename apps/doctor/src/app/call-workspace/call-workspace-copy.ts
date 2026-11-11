import type { WorkspaceTabDef as LibTabDef } from '@supadoc/call-workspace';

/*
 * The call workspace's tabs and every string it shows (the shared shell,
 * `@supadoc/call-workspace`, holds none of the doctor's words). Plain text:
 * rendered with Angular interpolation, never as HTML.
 */

export type WorkspaceTab = 'notes' | 'prescriptions' | 'labs' | 'followup' | 'copilot' | 'record';

export type WorkspaceTabDef = LibTabDef<WorkspaceTab>;

export const WS_TABS: readonly WorkspaceTabDef[] = [
  { key: 'notes', label: 'Consultation Notes', icon: 'square-pen' },
  { key: 'prescriptions', label: 'Prescriptions', icon: 'pill' },
  { key: 'labs', label: 'Lab requests', icon: 'flask-conical' },
  { key: 'followup', label: 'Follow-ups', icon: 'calendar-clock' },
  { key: 'copilot', label: 'Transcript & AI', icon: 'sparkles' },
  { key: 'record', label: 'Full EMR', icon: 'clipboard-list' },
];

/** The cockpit's launchers: the five tools (the Full EMR opens from "View Full EMR"). */
export const WS_LAUNCHERS: readonly WorkspaceTabDef[] = WS_TABS.filter((t) => t.key !== 'record');

export const WS_KICKER = 'Consultation tools';
export const WS_CLOSE = 'Close consultation tools';
/** The tab marks' screen-reader words, read after the tab's label (the shell draws the dots). */
export const WS_TAB_UNSAVED = ', unsaved changes';
/** A lab request being written and not sent (nothing is saved before sending). */
export const WS_TAB_UNSENT = ', not sent';
export const WS_TAB_LIVE = ', transcribing';
export const WS_TOOLS_HINT = (first: string) => `Open over the call. ${first || 'The patient'} stays in view.`;
export const wsShareBanner = (recording: boolean) =>
  recording
    ? "You're sharing your screen and the call is being recorded. Everyone in the call, and the recording, can see these consultation tools."
    : "You're sharing your screen. Everyone in the call can see these consultation tools.";
export const WS_RECORD_SHOWN = 'Patient record shown while you share your screen.';
export const WS_UNSAVED = 'Unsaved changes';
export const WS_EMR_SIGNED_OUT = "Sign in to the doctor portal to see the patient's record. The sign-in page opens in a new tab, so this call keeps going.";
export const WS_EMR_FAILED = "We couldn't open this patient's record.";
export const WS_EMR_NO_DETAILS = "The patient's record is available once this consultation's details have loaded.";
export const WS_VISIT_CURRENT = "You're in this consultation now. Its note and orders are in the other tabs.";
export const WS_RESULTS_NOT_SHARED = "These results aren't shared with you right now.";
export const WS_EMR_DOCS_EMPTY = 'Nothing is shared with you for this consultation yet. Ask for documents from Records in the call.';
export const WS_EMR_DOCS_FAILED = "We couldn't load the shared documents.";

/** The API refused a doctor for their standing: its fallback copy (the API's own message comes first). */
export const STANDING_TERMS = 'Accept the updated practitioner terms to continue consultations.';
export const STANDING_REFUSED = 'Your account can no longer take consultations.';

/** Launcher statuses: short visible words + the sr-only rest (§2.1). */
export const WS_STATUS = {
  loading: { text: 'Loading…' },
  noteNotLoaded: { text: 'Not loaded', sr: ' — open the note to try again' },
  signed: { text: 'Signed' },
  saveFailed: { text: 'Not saved', sr: ' — open the note to retry' },
  onDevice: { text: 'On this device', sr: ' — sign in to sync' },
  signedOut: { text: 'Not saved', sr: ' — sign in to save' },
  unsaved: { text: 'Unsaved', sr: ' changes' },
  labUnsent: { text: 'Not sent', sr: ' — lab request in progress' },
  live: { text: 'Live', sr: ' — transcribing' },
  draftReady: { text: 'Draft ready', sr: ' — AI draft' },
} as const;

/** The refusal's text: the API's message, else the shared fallback. */
export function standingText(code: string, message: string): string {
  return message || (code === 'terms_required' ? STANDING_TERMS : STANDING_REFUSED);
}
