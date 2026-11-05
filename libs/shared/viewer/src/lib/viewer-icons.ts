import { inject, type Provider } from '@angular/core';
import { LUCIDE_ICONS, type LucideIconData, type LucideIcons } from '@lucide/angular';

/**
 * The icons only the viewer uses, as icon DATA (Lucide 1.23.0, ISC licence:
 * https://lucide.dev/license) rather than the `Lucide…` component classes. Those
 * classes live in the one `@lucide/angular` module that every app's root
 * already imports, so the bundler puts any of them in the initial bundle, even
 * when only a lazy chunk uses it (measured: +10.5 kB); this data stays in the
 * viewer's chunk. Registered on the (lazy) outlet and body, never in
 * `provideSupadocIcons()`.
 * The viewer also uses app-wide ones (zoom-in, zoom-out, printer, download,
 * chevron-*, x, lock, shield-check, eye-off, file-text, video,
 * triangle-alert, refresh-cw, ellipsis, circle-alert, mic-off).
 */
export const VIEWER_ICONS: readonly LucideIconData[] = [
  { name: 'rotate-cw', node: [['path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }]] },
  { name: 'rotate-ccw', node: [['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }], ['path', { d: 'M3 3v5h5' }]] },
  { name: 'panel-left', node: [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }], ['path', { d: 'M9 3v18' }]], aliases: ['sidebar'] },
  { name: 'panel-left-close', node: [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }], ['path', { d: 'M9 3v18' }], ['path', { d: 'm16 15-3-3 3-3' }]], aliases: ['sidebar-close'] },
  { name: 'maximize', node: [['path', { d: 'M8 3H5a2 2 0 0 0-2 2v3' }], ['path', { d: 'M21 8V5a2 2 0 0 0-2-2h-3' }], ['path', { d: 'M3 16v3a2 2 0 0 0 2 2h3' }], ['path', { d: 'M16 21h3a2 2 0 0 0 2-2v-3' }]] },
  { name: 'minimize', node: [['path', { d: 'M8 3v3a2 2 0 0 1-2 2H3' }], ['path', { d: 'M21 8h-3a2 2 0 0 1-2-2V3' }], ['path', { d: 'M3 16h3a2 2 0 0 1 2 2v3' }], ['path', { d: 'M16 21v-3a2 2 0 0 1 2-2h3' }]] },
  { name: 'keyboard', node: [['path', { d: 'M10 8h.01' }], ['path', { d: 'M12 12h.01' }], ['path', { d: 'M14 8h.01' }], ['path', { d: 'M16 12h.01' }], ['path', { d: 'M18 8h.01' }], ['path', { d: 'M6 8h.01' }], ['path', { d: 'M7 16h10' }], ['path', { d: 'M8 12h.01' }], ['rect', { width: '20', height: '16', x: '2', y: '4', rx: '2' }]] },
  { name: 'image', node: [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2', ry: '2' }], ['circle', { cx: '9', cy: '9', r: '2' }], ['path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' }]] },
  { name: 'chevron-up', node: [['path', { d: 'm18 15-6-6-6 6' }]] },
  { name: 'picture-in-picture-2', node: [['path', { d: 'M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4' }], ['rect', { width: '10', height: '7', x: '12', y: '13', rx: '2' }]] },
  { name: 'move-horizontal', node: [['path', { d: 'm18 8 4 4-4 4' }], ['path', { d: 'M2 12h20' }], ['path', { d: 'm6 8-4 4 4 4' }]] },
  { name: 'scan', node: [['path', { d: 'M3 7V5a2 2 0 0 1 2-2h2' }], ['path', { d: 'M17 3h2a2 2 0 0 1 2 2v2' }], ['path', { d: 'M21 17v2a2 2 0 0 1-2 2h-2' }], ['path', { d: 'M7 21H5a2 2 0 0 1-2-2v-2' }]] },
  { name: 'info', node: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M12 16v-4' }], ['path', { d: 'M12 8h.01' }]] },
];

/** name (and aliases) → icon data, as `provideLucideIcons` keys them. */
export function iconDictionary(icons: readonly LucideIconData[]): LucideIcons {
  const out: LucideIcons = {};
  for (const icon of icons) {
    out[icon.name] = icon;
    for (const alias of icon.aliases ?? []) out[alias] = icon;
  }
  return out;
}

/**
 * A MERGING provider: `LUCIDE_ICONS` is a plain (non-multi) token, so the
 * viewer adds its icons to the app's set found above it instead of hiding it.
 */
export function provideViewerIcons(): Provider {
  return {
    provide: LUCIDE_ICONS,
    useFactory: () => ({ ...inject(LUCIDE_ICONS, { skipSelf: true }), ...iconDictionary(VIEWER_ICONS) }),
  };
}
