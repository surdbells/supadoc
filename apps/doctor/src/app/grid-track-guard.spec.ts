/// <reference types="node" />
// Node types for this spec only: it reads this app's templates from disk.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Mobile overflow guard: a grid that only sets its columns from a breakpoint up
 * (`grid gap-6 lg:grid-cols-2`) has one implicit `auto` column below it, which
 * grows to its widest unbreakable line. A `truncate` line inside then stretches
 * the card past the phone screen (the doctor dashboard's Today's Schedule and
 * Notifications cards). Every such grid states its base track: `grid-cols-1`
 * (= minmax(0, 1fr)), so the column is the container's width and text truncates
 * or wraps inside it. Scans this app's templates and class constants (.ts and
 * .html, specs excluded).
 */
const APP_SRC = 'apps/doctor/src';

/** This app's source folder. The unit-test builder runs bundled specs, so look upward from the working directory. */
function appSrc(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, APP_SRC);
    if (existsSync(join(candidate, 'app'))) return candidate;
    if (dirname(dir) === dir)
      throw new Error(`${APP_SRC} not found above ${process.cwd()}`);
  }
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|html)$/.test(name) && !name.endsWith('.spec.ts') ? [p] : [];
  });
}

/** Class lists (one-line quoted strings) that are a grid with breakpoint columns but no base column template. */
const hits = (text: string) =>
  [...text.matchAll(/(["'`])([^"'`\n]*)\1/g)]
    .map((m) => m[2])
    .filter((value) => {
      const tokens = value.split(/\s+/);
      return (
        tokens.includes('grid') &&
        tokens.some((t) =>
          /^(sm|md|lg|xl|2xl|min-\[[^\]]+\]):grid-cols-/.test(t),
        ) &&
        !tokens.some((t) => /^grid-cols-/.test(t))
      );
    });

describe('grid track guard (no implicit auto column below a breakpoint)', () => {
  it('every responsive grid in this app sets a base column template', () => {
    const src = appSrc();
    const scanned = files(src);
    expect(scanned.length).toBeGreaterThan(10);
    const found: string[] = [];
    for (const file of scanned) {
      for (const h of hits(readFileSync(file, 'utf8')))
        found.push(`${file.slice(src.length + 1)}: ${h}`);
    }
    expect(found).toEqual([]);
  });

  it('would catch one (self-test)', () => {
    expect(hits('<div class="grid gap-6 lg:grid-cols-2">')).toHaveLength(1);
    expect(
      hits("const G = 'grid items-start gap-4 sm:grid-cols-2';"),
    ).toHaveLength(1);
    expect(
      hits('<dl class="grid gap-3 md:grid-cols-[1fr_auto]">'),
    ).toHaveLength(1);
    expect(
      hits('<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">'),
    ).toHaveLength(0);
    expect(
      hits('<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">'),
    ).toHaveLength(0);
    expect(
      hits('<div class="flex gap-2 lg:grid lg:grid-cols-2">'),
    ).toHaveLength(0);
    expect(hits('<div class="grid gap-2">')).toHaveLength(0);
  });
});
