import { distance, panDelta, PinchTracker, scrollAfterZoom, wheelFactor } from './viewer-gestures';
import {
  autoScale,
  clampZoom,
  fitPageScale,
  fitWidthScale,
  MAX_CANVAS_AREA,
  nextZoom,
  renderScale,
  rotatedSize,
  stagePadding,
  ZOOM_PRESETS,
  zoomFor,
  zoomPercent,
} from './viewer-zoom';

describe('viewer-zoom', () => {
  it('steps through the presets and clamps to 25–400 %', () => {
    expect(ZOOM_PRESETS[0]).toBe(0.25);
    expect(ZOOM_PRESETS[ZOOM_PRESETS.length - 1]).toBe(4);
    expect(nextZoom(1, 1)).toBe(1.1);
    expect(nextZoom(1, -1)).toBe(0.9);
    expect(nextZoom(1.17, 1)).toBe(1.25);
    expect(nextZoom(1.17, -1)).toBe(1.1);
    expect(nextZoom(4, 1)).toBe(4);
    expect(nextZoom(0.25, -1)).toBe(0.25);
    expect(clampZoom(9)).toBe(4);
    expect(clampZoom(0.01)).toBe(0.25);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('padding is 16 px, 8 px below 640 px', () => {
    expect(stagePadding(1024)).toBe(16);
    expect(stagePadding(375)).toBe(8);
  });

  it('fit width and fit page', () => {
    // A4 at 100 %: 794 × 1123 CSS px.
    expect(fitWidthScale(1032, 1000, 16)).toBeCloseTo(1);
    expect(fitWidthScale(100000, 100, 16)).toBe(4);
    expect(fitPageScale(1032, 532, 1000, 1000, 16)).toBeCloseTo(0.5);
    expect(fitPageScale(532, 5000, 1000, 1000, 16)).toBeCloseTo(0.5);
  });

  it('auto: portrait PDF min(fit width, 1.25); landscape PDF fit page; images never above 100 %', () => {
    expect(autoScale('pdf', 1232, 800, 794, 1123, 16)).toBe(1.25);
    expect(autoScale('pdf', 500, 800, 794, 1123, 16)).toBeCloseTo((500 - 32) / 794);
    expect(autoScale('pdf', 1232, 632, 1123, 794, 16)).toBeCloseTo(fitPageScale(1232, 632, 1123, 794, 16));
    expect(autoScale('image', 4000, 4000, 400, 300, 16)).toBe(1);
    expect(autoScale('image', 432, 4000, 800, 600, 16)).toBeCloseTo(0.5);
    expect(zoomFor('custom', 2.2, 'pdf', { width: 800, height: 600 }, { width: 794, height: 1123 }, 16)).toBe(2.2);
    expect(zoomFor('width', 2.2, 'pdf', { width: 826, height: 600 }, { width: 794, height: 1123 }, 16)).toBeCloseTo(1);
  });

  it('renderScale multiplies by the DPR and stays under the iOS canvas area', () => {
    expect(renderScale(1, 2, 100, 100)).toBe(2);
    const s = renderScale(4, 3, 1000, 1400);
    expect(1000 * s * 1400 * s).toBeLessThanOrEqual(MAX_CANVAS_AREA + 1);
  });

  it('rotation swaps the size; percent rounds', () => {
    expect(rotatedSize(600, 800, 90)).toEqual({ width: 800, height: 600 });
    expect(rotatedSize(600, 800, 180)).toEqual({ width: 600, height: 800 });
    expect(zoomPercent(1.246)).toBe(125);
  });
});

describe('viewer-gestures', () => {
  it('keeps the point under the fingers put after a zoom', () => {
    expect(scrollAfterZoom(100, 200, { x: 50, y: 50 }, 2)).toEqual({ left: 250, top: 450 });
    expect(scrollAfterZoom(0, 0, { x: 10, y: 10 }, 0.5)).toEqual({ left: 0, top: 0 });
  });

  it('wheel factor: up zooms in, down zooms out, lines and pages count', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(-1, 1)).toBeCloseTo(wheelFactor(-16));
  });

  it('pinch tracker gives the distance ratio and the centre while two pointers are down', () => {
    const p = new PinchTracker();
    p.down(1, { x: 0, y: 0 });
    expect(p.move(1, { x: 1, y: 1 })).toBeNull();
    p.down(2, { x: 100, y: 0 });
    const r = p.move(2, { x: 201, y: 0 });
    expect(r?.scale).toBeCloseTo(distance({ x: 1, y: 1 }, { x: 201, y: 0 }) / distance({ x: 1, y: 1 }, { x: 100, y: 0 }));
    p.up(2);
    expect(p.active).toBe(false);
    expect(panDelta({ x: 1, y: 1 }, { x: 4, y: -1 })).toEqual({ dx: 3, dy: -2 });
  });

  it('a pinch that paused (its zoom committed) measures later moves from there: 1.5x then a little more is about 1.55x, not 2.3x', () => {
    const p = new PinchTracker();
    p.down(1, { x: 0, y: 0 });
    p.down(2, { x: 100, y: 0 });
    expect(p.move(2, { x: 150, y: 0 })?.scale).toBeCloseTo(1.5);
    p.rebase();
    const after = p.move(2, { x: 155, y: 0 });
    expect(after?.scale).toBeCloseTo(155 / 150);
    // What the viewer applies: the committed 1.5 times the new ratio.
    expect(1.5 * (after?.scale ?? 0)).toBeCloseTo(1.55);
    // One finger lifted: nothing to rebase, and nothing breaks.
    p.up(2);
    p.rebase();
    expect(p.active).toBe(false);
  });

  it('a pinch that paused (its zoom committed) measures later moves from there: 1.5x then a little more is about 1.55x, not 2.3x', () => {
    const p = new PinchTracker();
    p.down(1, { x: 0, y: 0 });
    p.down(2, { x: 100, y: 0 });
    expect(p.move(2, { x: 150, y: 0 })?.scale).toBeCloseTo(1.5);
    p.rebase();
    const after = p.move(2, { x: 155, y: 0 });
    expect(after?.scale).toBeCloseTo(155 / 150);
    // The zoom the viewer applies: the committed 1.5 times the new ratio.
    expect(1.5 * (after?.scale ?? 0)).toBeCloseTo(1.55);
    // One finger lifted: nothing to rebase, and nothing breaks.
    p.up(2);
    p.rebase();
    expect(p.active).toBe(false);
  });
});
