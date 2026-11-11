/**
 * What the patient app says about a reading above its usual entry range — one
 * place, so the form, Medical Information and the call screen agree. Calm and
 * professional: it asks the patient to check the reading and, if it is right,
 * to seek urgent care. Never a diagnosis.
 */

/** "45 °C", "260/160 mmHg", "90 kg/m²", "60 breaths/min". */
function upTo(max: string | number, unit: string): string {
  return `${max}${unit ? ` ${unit}` : ''}`;
}

/** Under a box on the "Update vitals" form. */
export function aboveRangeWarning(max: string | number, unit: string): string {
  return (
    `This is higher than readings usually go (up to ${upTo(max, unit)}). ` +
    'Please check it was measured and entered correctly. If it is right, seek urgent medical attention.'
  );
}

/** Under the worked-out BMI. */
export function bmiAboveRangeWarning(max: string | number): string {
  return (
    `This BMI is higher than readings usually go (up to ${upTo(max, 'kg/m²')}). ` +
    'Please check your weight and height were entered correctly. If they are right, seek urgent medical attention.'
  );
}

/** Beside the Save button; '' when nothing is above range. */
export function aboveRangeSummary(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? '1 reading is higher than readings usually go. Please check it before you save.'
    : `${count} readings are higher than readings usually go. Please check them before you save.`;
}

/** Medical Information's alert line for a current reading (the API's advice follows it). */
export function aboveRangeAlert(
  name: string,
  max: string | null | undefined,
  unit: string,
): string {
  return max
    ? `${name} is higher than readings usually go (up to ${upTo(max, unit)}). Please check it was measured and entered correctly.`
    : `${name} is higher than readings usually go. Please check it was measured and entered correctly.`;
}

/** The same for an out-of-date reading (followed by "update your readings"). */
export function aboveRangeStaleAlert(name: string, on: string): string {
  return `${name} was higher than readings usually go${on ? ` on ${on}` : ''}`;
}

/** Status suffix on a Medical Information card. */
export const ABOVE_RANGE_CARD_NOTE = 'Check reading';

/** Said to screen readers (and in the hover title) on that card. */
export const ABOVE_RANGE_CARD_DETAIL =
  'higher than readings usually go — please check it';

/** Under a reading on the in-call vitals tiles. */
export const ABOVE_RANGE_CALL_NOTE = 'Higher than usual — please check';

/** Beyond the API's sanity ceiling (mirrors its message). */
export function ceilingError(
  label: string,
  hardMax: number,
  unit: string,
): string {
  return `${label} can't be more than ${upTo(hardMax, unit)}. Check the reading.`;
}

export function bpCeilingError(hardMax: number): string {
  return `Blood pressure numbers can't be more than ${hardMax}. Check the reading.`;
}

/** Below the minimum of a reading that accepts higher values. */
export function belowMinError(
  label: string,
  min: number | null,
  unit: string,
): string {
  return `${label} must be at least ${upTo(min ?? 0, unit)}`;
}
