/**
 * Pan, pinch and wheel maths (§1.5.4), plus a small pointer tracker. Pure
 * apart from the tracker's own state; the viewer wires it outside Angular.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Where to scroll after the content scaled by `ratio` so the point under the
 * fingers / cursor (`point`, relative to the scroller's box) stays put.
 */
export function scrollAfterZoom(scrollLeft: number, scrollTop: number, point: Point, ratio: number): { left: number; top: number } {
  return {
    left: Math.max(0, (scrollLeft + point.x) * ratio - point.x),
    top: Math.max(0, (scrollTop + point.y) * ratio - point.y),
  };
}

/** The zoom factor of one wheel step (trackpad pinch arrives as Ctrl+wheel with small deltas). */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = Math.max(-100, Math.min(100, px));
  return Math.exp(-clamped * 0.0025);
}

/**
 * Two-pointer pinch tracking: feed it pointer events; `scale` is the ratio of
 * the current to the starting finger distance while two pointers are down.
 */
export class PinchTracker {
  private readonly points = new Map<number, Point>();
  private startDistance = 0;

  /** Two pointers are down. */
  get active(): boolean {
    return this.points.size === 2 && this.startDistance > 0;
  }

  down(id: number, p: Point): void {
    this.points.set(id, p);
    if (this.points.size === 2) {
      const [a, b] = [...this.points.values()];
      this.startDistance = distance(a, b);
    }
  }

  /** The pinch ratio and centre after a move, or null when not pinching. */
  move(id: number, p: Point): { scale: number; center: Point } | null {
    if (!this.points.has(id)) return null;
    this.points.set(id, p);
    if (!this.active) return null;
    const [a, b] = [...this.points.values()];
    return { scale: distance(a, b) / this.startDistance, center: midpoint(a, b) };
  }

  /**
   * The zoom so far was committed (the gesture paused): measure later moves
   * from the fingers' current distance, so the committed ratio is not applied
   * again on top of the new zoom.
   */
  rebase(): void {
    if (!this.active) return;
    const [a, b] = [...this.points.values()];
    const d = distance(a, b);
    if (d > 0) this.startDistance = d;
  }

  up(id: number): void {
    this.points.delete(id);
    if (this.points.size < 2) this.startDistance = 0;
  }

  reset(): void {
    this.points.clear();
    this.startDistance = 0;
  }
}

/** Mouse drag-to-pan: the scroll deltas for a pointer move. */
export function panDelta(from: Point, to: Point): { dx: number; dy: number } {
  return { dx: to.x - from.x, dy: to.y - from.y };
}
