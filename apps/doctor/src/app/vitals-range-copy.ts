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

/** The side panel and the call's chart: under a flagged reading. */
export function chartAboveRange(
  max: string | null | undefined,
  unit: string,
): string {
  return max
    ? `Above the expected range (max ${maxWithUnit(max, unit)}) — confirm the reading.`
    : 'Above the expected range — confirm the reading.';
}

/** A saved prescription's reading tile. */
export const RX_PAGE_ABOVE_RANGE = 'Above expected range — verify';
