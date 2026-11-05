import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, type Signal, signal } from '@angular/core';
import type { ViewerTone } from './viewer-types';

/**
 * `html[data-theme]` as a signal ('dark' or 'light'), kept current by a
 * MutationObserver (the patient app's theme switch). Call in an injection
 * context; the observer stops with it.
 */
export function pageTheme(): Signal<'dark' | 'light'> {
  const doc = inject(DOCUMENT);
  const read = (): 'dark' | 'light' => (doc.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const theme = signal(read());
  if (typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(() => theme.set(read()));
    mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    inject(DestroyRef).onDestroy(() => mo.disconnect());
  }
  return theme.asReadonly();
}

/** The resolved tone class: light, the call cockpit (dark) or the patient's dark mode. */
export type ResolvedTone = 'light' | 'cockpit' | 'patient-dark';

export function resolveTone(tone: ViewerTone, page: 'dark' | 'light'): ResolvedTone {
  if (tone === 'dark') return 'cockpit';
  if (tone === 'auto') return page === 'dark' ? 'patient-dark' : 'light';
  return 'light';
}

type Tokens = Record<string, string>;

/*
 * Every value is a tailwind/theme.css token or the patient dark value already
 * used in apps/patient/src/styles.css (§1.9). Contrast, measured (WCAG 2.x;
 * alpha values composited over the surface they sit on):
 *              text/chrome text/stage muted/chrome muted/stage control control/hover ring/chrome ring/stage pressed
 * light          14.42      12.49       5.40        4.68       5.40      5.08         5.41        4.68      6.29
 * cockpit        14.42      18.13       8.19        9.69      10.81      8.17        10.27       12.91      6.75
 * patient dark   14.03      15.65       6.63        7.39       6.63      5.53         8.50        9.48      6.46
 * Danger text on its soft tint (chrome / stage): light 5.71 / 4.98, cockpit 12.98 / 16.22, patient dark 6.75 / 7.56.
 * Warning text on its soft tint (chrome / stage): light 5.29 / 4.67, cockpit 10.25 / 13.15, patient dark 6.93 / 7.87.
 * Accent (current thumbnail ring) on chrome: light 5.41, cockpit 5.68, patient dark 8.50.
 * Call band (ink): white 14.42, white/70 7.83. Pages are white in every tone (they are the document).
 */
const SHARED: Tokens = {
  '--sd-viewer-page': '#ffffff',
  '--sd-viewer-band': '#1c2b3a',
  '--sd-viewer-band-border': 'rgb(255 255 255 / 0.10)',
  '--sd-viewer-pip-bg': '#0a1628',
  '--sd-viewer-pip-border': 'rgb(255 255 255 / 0.15)',
  '--sd-viewer-pip-pill': 'rgb(10 22 40 / 0.6)',
};

const TONES: Record<ResolvedTone, Tokens> = {
  light: {
    '--sd-viewer-chrome': '#ffffff',
    '--sd-viewer-stage': '#eceff1',
    '--sd-viewer-text': '#1c2b3a',
    '--sd-viewer-muted': '#546e7a',
    '--sd-viewer-border': '#eceff1',
    '--sd-viewer-control': '#546e7a',
    '--sd-viewer-hover': '#f1f9ff',
    '--sd-viewer-pressed-bg': '#e3f0fd',
    '--sd-viewer-pressed-fg': '#0a4fbf',
    '--sd-viewer-ring': '#0b62e4',
    '--sd-viewer-accent': '#0b62e4',
    '--sd-viewer-danger-soft': 'rgb(229 57 53 / 0.1)',
    '--sd-viewer-danger-text': '#b71c1c',
    '--sd-viewer-warn-soft': 'rgb(242 169 0 / 0.16)',
    '--sd-viewer-warn-text': '#8a5a00',
    '--sd-viewer-skeleton': '#dfe5ea',
    'color-scheme': 'light',
  },
  cockpit: {
    '--sd-viewer-chrome': '#1c2b3a',
    '--sd-viewer-stage': '#0a1628',
    '--sd-viewer-text': '#ffffff',
    '--sd-viewer-muted': 'rgb(255 255 255 / 0.72)',
    '--sd-viewer-border': 'rgb(255 255 255 / 0.10)',
    '--sd-viewer-control': 'rgb(255 255 255 / 0.85)',
    '--sd-viewer-hover': 'rgb(255 255 255 / 0.10)',
    '--sd-viewer-pressed-bg': 'rgb(187 222 251 / 0.16)',
    '--sd-viewer-pressed-fg': '#bbdefb',
    '--sd-viewer-ring': '#bbdefb',
    '--sd-viewer-accent': '#4fa8f7',
    '--sd-viewer-danger-soft': 'rgb(229 57 53 / 0.15)',
    '--sd-viewer-danger-text': '#ffffff',
    '--sd-viewer-warn-soft': 'rgb(242 169 0 / 0.18)',
    '--sd-viewer-warn-text': '#ffffff',
    '--sd-viewer-skeleton': 'rgb(255 255 255 / 0.08)',
    'color-scheme': 'dark',
  },
  'patient-dark': {
    '--sd-viewer-chrome': '#161f2b',
    '--sd-viewer-stage': '#0d141c',
    '--sd-viewer-text': '#e5edf4',
    '--sd-viewer-muted': '#94a6b5',
    '--sd-viewer-border': '#29323f',
    '--sd-viewer-control': '#94a6b5',
    '--sd-viewer-hover': 'rgb(33 111 209 / 0.18)',
    '--sd-viewer-pressed-bg': 'rgb(33 111 209 / 0.26)',
    '--sd-viewer-pressed-fg': '#8cbcff',
    '--sd-viewer-ring': '#8cbcff',
    '--sd-viewer-accent': '#8cbcff',
    '--sd-viewer-danger-soft': 'rgb(229 57 53 / 0.1)',
    '--sd-viewer-danger-text': '#ff8a80',
    '--sd-viewer-warn-soft': 'rgb(242 169 0 / 0.1)',
    '--sd-viewer-warn-text': '#f2a900',
    '--sd-viewer-skeleton': '#1d2836',
    'color-scheme': 'dark',
  },
};

/**
 * The viewer's colour tokens for a tone, as custom properties on the outlet
 * frame and the body host. Kept in script rather than in a stylesheet so they
 * cost no component-style budget and no initial CSS.
 */
export function viewerTokens(tone: ResolvedTone): Readonly<Tokens> {
  return { ...TONES[tone], ...SHARED };
}

/**
 * Writes the tokens onto `el` as inline properties (every tone has the same
 * keys, so each write replaces the last). Not a `[style]` map binding: the
 * first `[style]` map in an app pulls Angular's style-map parser (about 1 kB)
 * into its initial bundle, even when only lazy chunks use it (§8.1).
 */
export function applyViewerTokens(el: HTMLElement, tokens: Readonly<Tokens>): void {
  for (const [name, value] of Object.entries(tokens)) el.style.setProperty(name, value);
}
