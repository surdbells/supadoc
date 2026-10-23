import type { ApplicationStepKey, LicenceRoute } from '@supadoc/models';

export interface WizardStep {
  readonly key: ApplicationStepKey;
  /** Router path, without a leading slash. */
  readonly path: string;
  /** "Step n of 7". */
  readonly n: number;
  readonly title: string;
}

export const STEP_COUNT = 7;

/** The seven wizard steps, in order (the licence choice at /apply is a pre-step). */
export const STEPS: readonly WizardStep[] = [
  { key: 'personal', path: 'apply/personal', n: 1, title: 'Personal Details' },
  { key: 'professional', path: 'apply/professional', n: 2, title: 'Professional Details' },
  { key: 'licence', path: 'apply/licence', n: 3, title: 'Licence' },
  { key: 'qualifications', path: 'apply/qualifications', n: 4, title: 'Qualifications' },
  { key: 'documents', path: 'apply/documents', n: 5, title: 'Documents' },
  { key: 'indemnity', path: 'apply/indemnity', n: 6, title: 'Indemnity' },
  { key: 'consent', path: 'apply/consent', n: 7, title: 'Consent' },
];

export function stepOf(key: ApplicationStepKey): WizardStep {
  const step = STEPS.find((s) => s.key === key);
  if (!step) throw new Error(`Unknown step ${key}`);
  return step;
}

/** Absolute URL of a step, or of the review page. */
export function stepUrl(key: ApplicationStepKey | 'review'): string {
  return key === 'review' ? '/apply/review' : `/${stepOf(key).path}`;
}

/** 0-based position; 'review' comes after every step. */
export function stepIndex(key: ApplicationStepKey | 'review'): number {
  return key === 'review' ? STEPS.length : STEPS.findIndex((s) => s.key === key);
}

export function nextStepKey(key: ApplicationStepKey): ApplicationStepKey | 'review' {
  const i = stepIndex(key);
  return i >= STEPS.length - 1 ? 'review' : STEPS[i + 1].key;
}

/** The step before, or null for the first (whose Back goes to the licence choice). */
export function previousStepKey(key: ApplicationStepKey): ApplicationStepKey | null {
  const i = stepIndex(key);
  return i <= 0 ? null : STEPS[i - 1].key;
}

/** "Licence · Nigeria" / "Licence · Abroad"; other steps keep their title. */
export function stepTitle(key: ApplicationStepKey, route: LicenceRoute | null): string {
  if (key === 'licence') return route === 'abroad' ? 'Licence · Abroad' : 'Licence · Nigeria';
  return stepOf(key).title;
}
