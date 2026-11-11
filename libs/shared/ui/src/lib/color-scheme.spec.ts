import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * "Native pickers follow their surface" (tailwind/theme.css, NP1 and NP2). A native
 * dropdown's list, date picker or checkbox is drawn by the browser from the element's
 * color-scheme, so the surfaces that paint themselves declare one, and every option
 * list is the user agent's own Canvas/CanvasText pair. jsdom resolves neither system
 * colours nor color-scheme: the real render checks the result; this checks the rules.
 * `tailwind/theme.css` is a declared input of this test (project.json).
 */
const ROOT = resolve(__dirname, '../../../../..');
const theme = readFileSync(resolve(ROOT, 'tailwind/theme.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');

/** The declarations of the first rule whose selector list is exactly `selector` (whitespace-normalised). */
function rule(selector: string, from = 0): { body: string; at: number } | null {
  const at = theme.indexOf(`${selector} {`, from);
  if (at < 0) return null;
  const open = at + selector.length + 1;
  return { body: theme.slice(open + 1, theme.indexOf('}', open)), at };
}

/** The text of the `@layer base { … }` blocks (brace-matched). */
function baseLayers(): string {
  const out: string[] = [];
  for (let i = theme.indexOf('@layer base {'); i >= 0; i = theme.indexOf('@layer base {', i + 1)) {
    let depth = 0;
    for (let j = theme.indexOf('{', i); j < theme.length; j++) {
      if (theme[j] === '{') depth++;
      else if (theme[j] === '}' && --depth === 0) {
        out.push(theme.slice(i, j + 1));
        break;
      }
    }
  }
  return out.join(' ');
}

describe('native pickers follow their surface (tailwind/theme.css)', () => {
  it('NP1: inside @layer base, every dropdown list is Canvas/CanvasText (disabled options GrayText)', () => {
    const base = baseLayers();
    expect(base).toContain('select:not([multiple], [size]) option, select:not([multiple], [size]) optgroup { background-color: Canvas; color: CanvasText; }');
    expect(base).toContain('select:not([multiple], [size]) option:disabled { color: GrayText; }');
  });

  it('NP2: the cockpit is dark, the light cockpit light, its stage and dock dark again, the paper zone light', () => {
    const dark = rule('.sd-call, .sd-call .bg-abyss');
    const light = rule(".sd-call[data-theme='light'], .sd-call[data-theme='light'] .bg-abyss");
    const dock = rule(".sd-call[data-theme='light'] :is(.sd-stage, .sd-dock), .sd-call[data-theme='light'] :is(.sd-stage, .sd-dock) .bg-abyss");
    const paper = rule('.sd-rx-zone');
    expect(dark?.body.trim()).toBe('color-scheme: dark;');
    expect(light?.body.trim()).toBe('color-scheme: light;');
    expect(dock?.body.trim()).toBe('color-scheme: dark;');
    expect(paper?.body.trim()).toBe('color-scheme: light;');
    // Equal specificity: the stage and dock win only by coming after the light pair.
    expect(dock?.at ?? -1).toBeGreaterThan(light?.at ?? Infinity);
    expect(light?.at ?? -1).toBeGreaterThan(dark?.at ?? Infinity);
  });

  it('NP2 is unlayered: no colour scheme is declared in the base layer, where any unlayered rule would beat it', () => {
    const base = baseLayers();
    expect(base).not.toContain('color-scheme');
  });
});
