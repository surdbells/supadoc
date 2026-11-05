import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * No palette colour utility in the viewer's own templates (§1.9): the patient
 * app repaints them under `html[data-theme='dark']` (`.bg-white` → #161f2b…),
 * whatever the viewer's tone. Every colour is a `--sd-viewer-*` token.
 * `tailwind/theme.css` is a declared input of this test (project.json).
 */
const ROOT = resolve(__dirname, '../../../../..');
const SRC = resolve(__dirname, '..');
const PREFIXES = ['bg', 'text', 'border', 'ring', 'outline', 'divide', 'fill', 'stroke', 'from', 'via', 'to', 'decoration', 'accent', 'caret', 'placeholder'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|html)$/.test(name) ? [p] : [];
  });
}

function palette(): string[] {
  const theme = readFileSync(resolve(ROOT, 'tailwind/theme.css'), 'utf8');
  const names = new Set<string>();
  for (const m of theme.matchAll(/--color-([a-z0-9-]+)\s*:/g)) names.add(m[1]);
  names.add('white');
  names.add('black');
  return [...names].sort((a, b) => b.length - a.length);
}

describe('palette guard', () => {
  const colours = palette();
  // A colour utility with any variant prefix or /opacity — the pattern is built here, never written out.
  const pattern = new RegExp(`(?:^|[\\s"'\`:])(?:${PREFIXES.join('|')})-(?:${colours.map((c) => c.replace(/-/g, '\\-')).join('|')})(?:/[0-9.]+)?(?=[\\s"'\`]|$)`, 'gm');

  it('reads the palette from tailwind/theme.css', () => {
    expect(colours).toContain('ink');
    expect(colours).toContain('cerulean');
    expect(colours.length).toBeGreaterThan(10);
  });

  it('no .ts / .html file under the lib uses a palette colour utility', () => {
    const hits: string[] = [];
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(pattern)) hits.push(`${file.slice(SRC.length + 1)}: ${m[0].trim()}`);
    }
    expect(hits).toEqual([]);
  });

  it('would catch one (self-test)', () => {
    const probe = ['class="flex', `${PREFIXES[0]}-${'white'}`, `hover:${PREFIXES[1]}-${'ink'}/70"`].join(' ');
    expect(probe.match(pattern)?.length).toBe(2);
  });
});
