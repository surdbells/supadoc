import {
  afterNextRender,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  NgZone,
} from '@angular/core';

/**
 * Eases a container's height when its content changes size (switching tabs,
 * adding rows, opening a section) instead of letting the layout jump.
 *
 * Usage — the content must be wrapped in ONE child element, whose natural size
 * the host follows:
 * ```html
 * <div sdSmoothHeight>
 *   <div>…content that changes height…</div>
 * </div>
 * ```
 * Overflow is clipped only while a transition runs, so dropdowns and focus
 * rings inside are never cut off at rest. Honours prefers-reduced-motion.
 */
@Directive({ selector: '[sdSmoothHeight]' })
export class SmoothHeightDirective {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly zone = inject(NgZone);

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const el = this.host.nativeElement;
      if (typeof ResizeObserver === 'undefined') return;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      let current = -1;

      const onEnd = (e: TransitionEvent) => {
        if (e.target === el && e.propertyName === 'height') el.style.overflow = '';
      };
      el.addEventListener('transitionend', onEnd);

      const observer = new ResizeObserver(() => {
        const child = el.firstElementChild as HTMLElement | null;
        if (!child) return;
        // border-box host: its height must also hold its own padding + border.
        const cs = getComputedStyle(el);
        const chrome =
          parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
          parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
        const next = Math.ceil(child.offsetHeight + (cs.boxSizing === 'border-box' ? chrome : 0));
        if (next === current) return;
        if (current < 0 || reduce) {
          // First measure (or reduced motion): follow without animating.
          el.style.transition = 'none';
          el.style.height = `${next}px`;
        } else {
          el.style.transition = 'height 220ms cubic-bezier(0.2, 0, 0, 1)';
          el.style.overflow = 'hidden';
          el.style.height = `${next}px`;
        }
        current = next;
      });

      this.zone.runOutsideAngular(() => {
        const child = el.firstElementChild;
        if (child) observer.observe(child);
      });
      destroyRef.onDestroy(() => {
        observer.disconnect();
        el.removeEventListener('transitionend', onEnd);
      });
    });
  }
}
