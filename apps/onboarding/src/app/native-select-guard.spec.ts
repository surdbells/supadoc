/// <reference types="node" />
// Node types for this spec only: it reads this app's templates from disk.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * NP1 (tailwind/theme.css): options never carry colour. A dropdown's list is painted
 * Canvas/CanvasText for its colour scheme by one base rule; a class or style on an
 * <option> or <optgroup> brings back same-on-same lists when a tone remap changes one
 * colour and not the other (ink on ink in the light cockpit, 1.00:1). Scans this app's
 * templates (.ts and .html, specs excluded).
 */
const APP_SRC = 'apps/onboarding/src';
const STYLED_OPTION =
  /<(option|optgroup)\b[^>]*\s(class|style|\[class(\.[^\]]+)?\]|\[className\]|\[ngClass\]|\[style(\.[^\]]+)?\]|\[ngStyle\]|\[attr\.(class|style)\])\s*=/gi;

/** This app's source folder. The unit-test builder runs bundled specs, so look upward from the working directory. */
function appSrc(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, APP_SRC);
    if (existsSync(join(candidate, 'app'))) return candidate;
    if (dirname(dir) === dir) throw new Error(`${APP_SRC} not found above ${process.cwd()}`);
  }
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|html)$/.test(name) && !name.endsWith('.spec.ts') ? [p] : [];
  });
}

const hits = (text: string) => [...text.matchAll(new RegExp(STYLED_OPTION.source, STYLED_OPTION.flags))].map((m) => m[0]);

describe('native select guard (NP1: options never carry colour)', () => {
  it('no <option> or <optgroup> in this app has a class or style', () => {
    const src = appSrc();
    const scanned = files(src);
    expect(scanned.length).toBeGreaterThan(10);
    const found: string[] = [];
    for (const file of scanned) {
      for (const h of hits(readFileSync(file, 'utf8'))) found.push(`${file.slice(src.length + 1)}: ${h.replace(/\s+/g, ' ')}`);
    }
    expect(found).toEqual([]);
  });

  it('would catch one (self-test)', () => {
    expect(hits('<option value="a" class="bg-ink">A</option>')).toHaveLength(1);
    expect(hits('<option [class.x]="y">A</option>')).toHaveLength(1);
    expect(hits('<option [className]="c">A</option>')).toHaveLength(1);
    expect(hits('<option [attr.style]="s">A</option>')).toHaveLength(1);
    expect(hits('<option [ngStyle]="s">A</option>')).toHaveLength(1);
    expect(hits('<option style="color: red">A</option>')).toHaveLength(1);
    expect(hits('<optgroup label="g" [ngClass]="k"></optgroup>')).toHaveLength(1);
    expect(hits('<option\n  value="a"\n  class="bg-white text-ink">A</option>')).toHaveLength(1);
    expect(hits('<option [value]="v" [selected]="a">A</option>')).toHaveLength(0);
    expect(hits('<select class="call-field"><option value="a">A</option></select>')).toHaveLength(0);
  });
});
