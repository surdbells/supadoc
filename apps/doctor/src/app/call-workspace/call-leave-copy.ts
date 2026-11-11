import type { LeaveCopy } from '@supadoc/ui';
import { UNSAVED_LAB_LEAVE } from '../lab/lab-composer';
import { UNSAVED_RX_LEAVE } from '../prescriptions/rx-shared';

/*
 * The call's one leave question (Leave, End, a route change): it names
 * everything a leave would lose, so two prompts never stack. Plain text,
 * rendered by the app's dialog outlet.
 */

/** What is at risk: a prescription with unsaved changes, a lab request not sent. */
export interface UnsavedWork {
  readonly rx: boolean;
  readonly lab: boolean;
}

const LIVE_RX: LeaveCopy = {
  tone: 'danger',
  icon: 'phone-off',
  title: 'Leave the call with an unsaved prescription?',
  message:
    "Your latest changes to the prescription haven't been saved, and leaving loses them. The visit stays open — you can rejoin from the appointment page.",
  confirmLabel: 'Leave without saving',
  cancelLabel: 'Stay in the call',
};

const LIVE_LAB: LeaveCopy = {
  tone: 'danger',
  icon: 'phone-off',
  title: 'Leave the call with an unsent lab request?',
  message: "Your lab request hasn't been sent, and leaving loses it. The visit stays open — you can rejoin from the appointment page.",
  confirmLabel: 'Leave without sending',
  cancelLabel: 'Stay in the call',
};

const LIVE_BOTH: LeaveCopy = {
  tone: 'danger',
  icon: 'phone-off',
  title: 'Leave the call with unsaved work?',
  message:
    "Your latest prescription changes haven't been saved and your lab request hasn't been sent. Leaving loses both. The visit stays open — you can rejoin from the appointment page.",
  confirmLabel: 'Leave anyway',
  cancelLabel: 'Stay in the call',
};

const DISCARD_BOTH: LeaveCopy = {
  tone: 'danger',
  title: 'Leave without saving or sending?',
  message: "Your latest prescription changes haven't been saved and your lab request hasn't been sent. Leaving now loses both.",
  confirmLabel: 'Leave anyway',
  cancelLabel: 'Keep editing',
};

/** "Leave the call?" while in it with nothing at risk: the visit stays open. */
function liveLeave(patientName: string): LeaveCopy {
  return {
    tone: 'warning',
    icon: 'door-open',
    title: 'Leave the call?',
    message: `The visit stays open — you can rejoin from the appointment page while ${patientName} is still there.`,
    confirmLabel: 'Leave call',
    cancelLabel: 'Stay',
  };
}

/** Leave and the route guard: the one question (in the live call, always one), or null for none. */
export function leaveCallCopy(work: UnsavedWork, live: boolean, patientName: string): LeaveCopy | null {
  if (!live) return discardDraftsCopy(work);
  if (work.rx && work.lab) return LIVE_BOTH;
  if (work.rx) return LIVE_RX;
  if (work.lab) return LIVE_LAB;
  return liveLeave(patientName);
}

/** End (asked before the End dialog), and Leave once the call is over: the one question, or null. */
export function discardDraftsCopy(work: UnsavedWork): LeaveCopy | null {
  if (work.rx && work.lab) return DISCARD_BOTH;
  if (work.rx) return UNSAVED_RX_LEAVE;
  if (work.lab) return UNSAVED_LAB_LEAVE;
  return null;
}
