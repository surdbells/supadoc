import type { WorkspaceTabDef } from '@supadoc/call-workspace';

/*
 * The patient's own record during the call: the Health Summary's "View Full
 * Record" and Documents & Records' "Manage" open it in the call's workspace
 * (never a page or a tab: either would end the call). Its two tabs and the
 * words the workspace shows for them. Plain text, rendered with Angular
 * interpolation.
 */

export type RecordTab = 'record' | 'sharing';

export const RECORD_TABS: readonly WorkspaceTabDef<RecordTab>[] = [
  { key: 'record', label: 'Health record', icon: 'heart-pulse' },
  { key: 'sharing', label: 'Document sharing', icon: 'share-2' },
];

export const isRecordTab = (key: string): key is RecordTab => key === 'record' || key === 'sharing';

export const RECORD_KICKER = 'Your health record';
export const RECORD_CLOSE = 'Close your health record';
/** The title when the patient's name is not known yet. */
export const RECORD_TITLE_FALLBACK = 'You';
/** The workspace's banner while the patient shares their screen. */
export const recordShareBanner = (recording: boolean) =>
  recording
    ? "You're sharing your screen and the call is being recorded. Everyone in the call, and the recording, can see your health record."
    : "You're sharing your screen. Everyone in the call can see your health record.";
/** The band's first button once the call is over. */
export const RECORD_BAND_CLOSE = 'Close record';
/** While a tab's content loads, or if it could not. */
export const RECORD_LOADING = 'Loading…';
export const RECORD_LOAD_FAILED = "This couldn't be loaded. Check your connection, then close and open it again.";
