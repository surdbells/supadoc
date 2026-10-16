/**
 * The page numbers a numbered pager shows, with `0` standing for an ellipsis:
 * always the first and last page, plus the current page and its neighbours.
 * A gap of a single page shows that page instead of an ellipsis, which would
 * take the same room.
 *
 * (1, 12) → [1, 2, 0, 12] · (6, 12) → [1, 0, 5, 6, 7, 0, 12] · (3, 4) → [1, 2, 3, 4]
 */
export function pageWindow(page: number, total: number): number[] {
  const last = Math.max(1, Math.floor(total) || 1);
  const current = Math.min(Math.max(1, Math.floor(page) || 1), last);
  const shown = [...new Set([1, current - 1, current, current + 1, last])]
    .filter((p) => p >= 1 && p <= last)
    .sort((a, b) => a - b);
  const out: number[] = [];
  let prev = 0;
  for (const p of shown) {
    if (p - prev === 2) out.push(p - 1);
    else if (p - prev > 2) out.push(0);
    out.push(p);
    prev = p;
  }
  return out;
}
