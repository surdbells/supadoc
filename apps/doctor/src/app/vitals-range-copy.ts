/**
 * What the doctor app says about a reading above its usual entry range (the
 * API accepts it; `flag.out_of_range` / `readings_above_range` mark it) — one
 * place, so the composer, side panel, prescription page and call agree.
 * Clinical and short: confirm the reading before acting on it.
 */

/** "45 °C", "260/160 mmHg". */
function maxWithUnit(
  max: string | number | null | undefined,
  unit: string,
): string {
  return `${max ?? ''}${unit ? ` ${unit}` : ''}`.trim();
}

/** Under a box on the prescription composer. */
export function rxAboveRange(
  key: string,
  max: string | number,
  unit: string,
): string {
  return key === 'bmi'
    ? `Above the expected range (max ${maxWithUnit(max, unit)}). Confirm weight and height before issuing.`
    : `Above the expected range (max ${maxWithUnit(max, unit)}). Confirm the reading before issuing.`;
}

/** The composer's action bar; '' when none. */
export function rxAboveRangeSummary(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? '1 reading above the expected range — confirm before issuing.'
    : `${count} readings above the expected range — confirm before issuing.`;
}

/** The Send dialog: "Temperature 46 °C, Heart rate 260 beats/min". */
export function rxAboveRangeSend(list: readonly string[]): string {
  return list.length
    ? `Above the expected range: ${list.join(', ')}. Confirm the readings before issuing.`
    : '';
}

/**
 * The side panel and the call's chart: under a flagged reading. A flag with no
 * `usual_max` is a weight within its own range whose BMI is above range (the
 * height is the usual suspect), so it names the BMI, not the weight.
 */
export function chartAboveRange(
  max: string | null | undefined,
  unit: string,
): string {
  return max
    ? `Above the expected range (max ${maxWithUnit(max, unit)}) — confirm the reading.`
    : 'Gives a BMI above the expected range — confirm weight and height.';
}

/**
 * Typed past what the API accepts (mirrors its messages, so the wording does
 * not change when the API's own error replaces it after Save or Send).
 */
export function rxTooLarge(label: string): string {
  return `${label} is too large to be a reading. Check what you entered.`;
}

export function rxBpTooLarge(hardMax: number): string {
  return `Each blood pressure number must be ${String(hardMax).length} digits or fewer. Check what you entered.`;
}

/** A bounded reading (oxygen, pain) above its maximum. */
export function rxOutOfBounds(
  label: string,
  min: number | null,
  max: number,
): string {
  return `${label} must be a number between ${min ?? 0} and ${max}`;
}

/** A saved prescription's reading tile. */
export const RX_PAGE_ABOVE_RANGE = 'Above expected range — verify';
