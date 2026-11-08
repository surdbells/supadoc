import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Lazy-only code can still grow every app's initial bundle (§8.1, ≤ 2 kB):
 * the build moves code that several lazy chunks share into `main`, and
 * Tailwind turns utility names found anywhere in the workspace into initial
 * CSS. Measured with a lazy page using the viewer (the same rule holds for
 * this lib, imported only from lazy call pages), these patterns cost:
 * - a `[style]` map binding: Angular's style-map parser, about 1 kB;
 * - rxjs `timer`: the operator and its scheduler, about 0.2 kB;
 * - a namespace import used as a value (`c = copy`): esbuild's export helper;
 * - an eased timing keyword in the lib's CSS strings: a global utility in every app's styles.
 * The patterns are built here, never written out (Tailwind scans this file too).
 */
const SRC = resolve(__dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [p] : [];
  });
}

const STYLE = 'style';
const styleMap = new RegExp(`\\[${STYLE}\\]\\s*=|'\\[${STYLE}\\]'\\s*:`);
const rxTimer = new RegExp(`import\\s*\\{[^}]*\\b${'tim' + 'er'}\\b[^}]*\\}\\s*from\\s*'rxjs'`);
const EASE = 'ease';
const eased = new RegExp(`\\b${EASE}-(?:in-out|in|out|linear)\\b`);

/** Namespace imports (`import * as x`) used as a value (assigned, returned, passed), not only as `x.member`. */
function namespaceValues(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(/import \* as (\w+) from [^;]+;/g)) {
    const name = m[1];
    const rest = text.replace(m[0], '');
    const value = new RegExp(`(?:[=:]|\\breturn)\\s*${name}\\s*[;,})\\n]|[(,]\\s*${name}\\s*[,)](?!\\s*=)`);
    if (value.test(rest)) hits.push(name);
  }
  return hits;
}

describe('bundle guard (lazy code that would grow the initial bundles)', () => {
  const sources = files(SRC).map((f) => ({ file: f.slice(SRC.length + 1), text: readFileSync(f, 'utf8') }));

  it('finds the lib sources', () => {
    expect(sources.some((s) => s.file.endsWith('call-workspace.ts'))).toBe(true);
    expect(sources.some((s) => s.file.endsWith('call-launchers.ts'))).toBe(true);
    expect(sources.some((s) => s.file.endsWith('peer-handover.ts'))).toBe(true);
  });

  it('no [style] map binding, no rxjs timer, no namespace object, no eased timing keyword', () => {
    const hits: string[] = [];
    for (const { file, text } of sources) {
      if (styleMap.test(text)) hits.push(`${file}: [${STYLE}] map binding`);
      if (rxTimer.test(text)) hits.push(`${file}: rxjs timer`);
      for (const n of namespaceValues(text)) hits.push(`${file}: namespace ${n} used as a value`);
      if (eased.test(text)) hits.push(`${file}: ${EASE}-* keyword`);
    }
    expect(hits).toEqual([]);
  });

  it('would catch each one (self-test)', () => {
    expect(styleMap.test(`<div [${STYLE}]="tokens()">`)).toBe(true);
    expect(styleMap.test(`host: { '[${STYLE}]': 'tokens()' }`)).toBe(true);
    expect(styleMap.test(`<div [${STYLE}.width.px]="w">`)).toBe(false);
    expect(rxTimer.test(`import { map, ${'tim' + 'er'} } from 'rxjs';`)).toBe(true);
    expect(namespaceValues(`import * as copy from './c';\nconst a = copy.A;\nreadonly c = copy;`)).toEqual(['copy']);
    expect(namespaceValues(`import * as copy from './c';\nf(copy);`)).toEqual(['copy']);
    expect(namespaceValues(`import * as copy from './c';\nconst a = copy.A;\n<div (copy)="deter($event)"></div>`)).toEqual([]);
    expect(eased.test(`animation:x 1s ${EASE}-in-out infinite`)).toBe(true);
    expect(eased.test('animation:x 1s cubic-bezier(.42,0,.58,1) infinite')).toBe(false);
  });
});
