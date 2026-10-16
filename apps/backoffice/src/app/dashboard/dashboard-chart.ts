/**
 * Geometry for the dashboard's inline-SVG charts (no chart library, no
 * innerHTML / bypassSecurityTrust — the template binds these numbers and
 * path strings to attributes). Everything is drawn to scale from a zero
 * baseline on "nice" ticks.
 */

export interface NiceScale {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** min … max by step, both ends included. */
  readonly ticks: readonly number[];
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * A y-scale that always includes 0, with about `tickCount` steps of
 * 1 / 2 / 2.5 / 5 × 10ⁿ (whole steps for counts).
 */
export function niceScale(lo: number, hi: number, tickCount = 4, integer = false): NiceScale {
  let min = Math.min(0, Number.isFinite(lo) ? lo : 0);
  let max = Math.max(0, Number.isFinite(hi) ? hi : 0);
  if (max === min) max = min + 1;
  const rough = (max - min) / Math.max(1, tickCount);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  if (integer) step = Math.max(1, Math.ceil(step));
  min = round6(Math.floor(round6(min / step)) * step);
  max = round6(Math.ceil(round6(max / step)) * step);
  const ticks: number[] = [];
  for (let i = 0, v = min; v <= max + step / 2 && i < 50; i++, v = round6(min + step * i)) ticks.push(v);
  return { min, max, step, ticks };
}

/** Where `v` sits on a vertical scale whose top edge is `top` and height `height`. */
export function yFor(v: number, scale: NiceScale, top: number, height: number): number {
  const span = scale.max - scale.min || 1;
  return top + height - ((v - scale.min) / span) * height;
}

const f = (v: number) => (Math.round(v * 10) / 10).toString();

/**
 * A column from the baseline (`y + h`) up to `y`: square at the baseline, the
 * data end rounded (radius capped by the column's width and height).
 */
export function columnPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (!(h > 0) || !(w > 0)) return '';
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return (
    `M${f(x)},${f(y + h)}V${f(y + rr)}` +
    `A${f(rr)},${f(rr)} 0 0 1 ${f(x + rr)},${f(y)}` +
    `H${f(x + w - rr)}` +
    `A${f(rr)},${f(rr)} 0 0 1 ${f(x + w)},${f(y + rr)}` +
    `V${f(y + h)}Z`
  );
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A polyline through the points. */
export function linePath(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${f(p.x)},${f(p.y)}`).join(' ');
}

/** The line closed down to `baseY` (an area wash). */
export function areaPath(points: readonly Point[], baseY: number): string {
  if (points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath(points)} L${f(last.x)},${f(baseY)} L${f(first.x)},${f(baseY)} Z`;
}

/**
 * Which days get an x-axis label: the last (today), then every `step` days
 * back — weekly when there is room, fortnightly on a phone.
 */
export function tickIndexes(n: number, plotWidth: number): number[] {
  if (n <= 0) return [];
  const step = plotWidth >= 360 ? 7 : 14;
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i -= step) out.unshift(i);
  return out;
}

/** Keep `v` within lo … hi. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
