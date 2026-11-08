import type { WorkspaceFlag, WorkspaceTabDef } from '@supadoc/call-workspace';

/*
 * The call page's consultation notes: the four launchers (also the workspace's
 * four tabs) and every word the workspace shows (the shared shell,
 * `@supadoc/call-workspace`, holds none of them). Plain text, rendered with
 * Angular interpolation, never as HTML. Announcements and statuses never name a
 * medicine, test, diagnosis or document.
 */

export type NotesTab = 'notes' | 'prescriptions' | 'labs' | 'followup';

export const NOTES_TABS: readonly WorkspaceTabDef<NotesTab>[] = [
  // Read, not written: no pen.
  { key: 'notes', label: 'Consultation Notes', icon: 'clipboard-list' },
  { key: 'prescriptions', label: 'Prescriptions', icon: 'pill' },
  { key: 'labs', label: 'Lab requests', icon: 'flask-conical' },
  { key: 'followup', label: 'Follow-up Plan', icon: 'calendar-clock' },
];

export const NOTES_KICKER = 'Consultation notes';
export const NOTES_CLOSE = 'Close consultation notes';
/** The card's hint while the doctor's video is in the workspace's picture-in-picture. */
export const notesHint = (dr: string) => `Open over the call. ${dr || 'Your doctor'} stays in view.`;
/** The card's hint once the call is over (no picture-in-picture then). */
export const NOTES_HINT_AFTER = 'Your notes from this consultation.';
/** The workspace tab mark for something new: a dot plus these words for screen readers. */
export const NOTES_TAB_NEW: WorkspaceFlag = { mark: 'new', sr: ', new' };
export const notesShareBanner = (recording: boolean) =>
  recording
    ? "You're sharing your screen and the call is being recorded. Everyone in the call, and the recording, can see these notes."
    : "You're sharing your screen. Everyone in the call can see these notes.";

/** Launcher statuses: short visible words + the sr-only rest. */
export const NOTES_STATUS = {
  finalized: { text: 'Finalized', sr: ' — your visit summary is ready' },
  newRx: { text: 'New', sr: ' prescription' },
  rxNotLoaded: { text: 'Not loaded', sr: ' — open to see why' },
  newLab: { text: 'New', sr: ' lab request' },
  proposed: { text: 'Proposed', sr: ' follow-up — answer it after your call' },
  newPlan: { text: 'New', sr: ' in your follow-up plan' },
} as const;

/** "1 prescription" / "3 prescriptions". */
export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What arrived during the call, for the polite announcements (never what it is). */
export const NEWS = {
  lab: (dr: string) => `${dr} sent you a lab request.`,
  proposal: (dr: string) => `${dr} proposed a follow-up.`,
  plan: (dr: string) => `${dr} updated your follow-up plan.`,
  summary: 'Your visit summary is ready.',
} as const;

/** The band's line once the call is over (the workspace stays usable). */
export const BAND_ENDED = {
  completed: 'Your consultation has ended.',
  dropped: 'You were disconnected from the call.',
} as const;

/** The band's row for the doctor's request to see the patient's documents. */
export const DOC_REQUEST = (dr: string) => `${dr} asked to see your documents`;
