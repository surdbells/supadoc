import type { ConfirmOptions } from '@supadoc/ui';

/**
 * The confirmations asked before clinical work that reaches the patient or
 * can't be undone — the same copy on the record page (Clinical tools) and in
 * the call cockpit. Pass the result to `DialogService.confirm()`.
 *
 * Only what the doctor needs to check is shown (type, dates, counts, priority)
 * — never a diagnosis or the reason for the visit.
 */

/** "Finalize and sign this note?" — it locks for good and the summary is shared. */
export function finalizeNotePrompt(patient: string): ConfirmOptions {
  return {
    tone: 'warning',
    icon: 'signature',
    title: 'Finalize and sign this note?',
    message: `It's signed and locked, and the summary is shared with ${patient}. You can't edit it afterwards.`,
    confirmLabel: 'Finalize & sign',
    cancelLabel: 'Keep editing',
  };
}

/** "Send this lab order to {patient}?" */
export function labOrderPrompt(patient: string, tests: number, priority: 'routine' | 'urgent'): ConfirmOptions {
  return {
    tone: 'info',
    icon: 'flask-conical',
    title: `Send this lab order to ${patient}?`,
    message: 'It appears in their consultation record straight away.',
    details: [
      { label: 'Tests', value: String(tests) },
      { label: 'Priority', value: priority === 'urgent' ? 'Urgent' : 'Routine' },
    ],
    confirmLabel: 'Send lab order',
    cancelLabel: 'Not yet',
  };
}

/** "Send this referral to {patient}?" */
export function referralPrompt(patient: string, target: string, priority: 'routine' | 'urgent'): ConfirmOptions {
  return {
    tone: 'info',
    icon: 'share-2',
    title: `Send this referral to ${patient}?`,
    message: 'It appears in their consultation record straight away, ready to download.',
    details: [
      { label: 'Refer to', value: target },
      { label: 'Priority', value: priority === 'urgent' ? 'Urgent' : 'Routine' },
    ],
    confirmLabel: 'Send referral',
    cancelLabel: 'Not yet',
  };
}

/** "Publish this care plan to {patient}?" (or "Update…" once one was published). */
export function carePlanPrompt(patient: string, steps: number, republish: boolean): ConfirmOptions {
  return {
    tone: 'info',
    icon: 'list-checks',
    title: republish ? `Update ${patient}'s care plan?` : `Publish this care plan to ${patient}?`,
    message: republish
      ? 'They see these steps in place of the ones you published before.'
      : 'They see these steps in their consultation record straight away.',
    details: [{ label: 'Steps', value: String(steps) }],
    confirmLabel: republish ? 'Publish update' : 'Publish to patient',
    cancelLabel: 'Not yet',
  };
}

export type CertificateKind = 'sick_leave' | 'fitness' | 'general';

const CERT_NAME: Record<CertificateKind, { title: string; type: string }> = {
  sick_leave: { title: 'sick-leave', type: 'Sick leave' },
  fitness: { title: 'fitness', type: 'Fitness / return to work' },
  general: { title: 'medical', type: 'General' },
};

/**
 * "Issue this sick-leave certificate?" with its type and (for sick leave) the
 * period — `period` is already formatted, e.g. "Tue 14 Oct – Fri 17 Oct".
 */
export function certificatePrompt(patient: string, kind: CertificateKind, period: string | null): ConfirmOptions {
  const name = CERT_NAME[kind] ?? CERT_NAME.general;
  return {
    tone: 'warning',
    icon: 'id-card',
    title: `Issue this ${name.title} certificate?`,
    message: `${patient} can download it straight away. It's signed in your name and can't be edited afterwards.`,
    details: [{ label: 'Type', value: name.type }, ...(period ? [{ label: 'Leave', value: period }] : [])],
    confirmLabel: 'Issue certificate',
    cancelLabel: 'Keep editing',
  };
}

/** "Stop recording?" */
export const STOP_RECORDING_PROMPT: ConfirmOptions = {
  tone: 'warning',
  icon: 'circle-stop',
  title: 'Stop recording?',
  message: 'The recording so far is saved. Starting again creates a separate file.',
  confirmLabel: 'Stop recording',
  cancelLabel: 'Keep recording',
};
