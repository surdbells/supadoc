import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, type Signal, signal } from '@angular/core';

/**
 * The viewer's layouts (§1.3): `desktop` ≥ 1024 px, `tablet` 640–1023 px,
 * `phone` < 640 px, and `compact` — a phone held sideways (the call pages'
 * `RAIL_QUERY` height rule), whatever its width.
 */
export type ViewerLayout = 'desktop' | 'tablet' | 'phone' | 'compact';

export const COMPACT_QUERY = '(orientation: landscape) and (max-height: 500px)';
const DESKTOP_QUERY = '(min-width: 1024px)';
const TABLET_QUERY = '(min-width: 640px)';

/** The current layout as a signal (desktop where `matchMedia` is missing, e.g. tests). */
export function viewerLayout(): Signal<ViewerLayout> {
  const view = inject(DOCUMENT).defaultView;
  const mm = view && typeof view.matchMedia === 'function' ? view.matchMedia.bind(view) : null;
  if (!mm) return signal<ViewerLayout>('desktop').asReadonly();
  const queries = [mm(COMPACT_QUERY), mm(DESKTOP_QUERY), mm(TABLET_QUERY)];
  const read = (): ViewerLayout => {
    if (queries[0]?.matches) return 'compact';
    if (queries[1]?.matches) return 'desktop';
    if (queries[2]?.matches) return 'tablet';
    return 'phone';
  };
  const layout = signal<ViewerLayout>(read());
  const update = () => layout.set(read());
  for (const q of queries) q?.addEventListener?.('change', update);
  inject(DestroyRef).onDestroy(() => {
    for (const q of queries) q?.removeEventListener?.('change', update);
  });
  return layout.asReadonly();
}

/** `prefers-reduced-motion: reduce`. */
export function reducedMotion(doc: Document = document): boolean {
  try {
    return !!doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
