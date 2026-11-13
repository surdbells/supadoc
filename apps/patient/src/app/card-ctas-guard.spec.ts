/// <reference types="node" />
// Node types for this spec only: it reads this app's templates and the shared theme from disk.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Card CTAs (2026-11-13): the buttons inside a card span the card's content width, never wrap
 * their label, and two of them sit side by side in equal columns only when both labels fit
 * (else they stack, in DOM order). One mechanism does it: the `sd-cta-row` utility in
 * tailwind/theme.css. Page-header CTAs beside a title hug their label on one line and shorten
 * to "Book" in a narrow row (screen readers still hear "Book Consultation").
 */

/** The repo root. The unit-test builder runs bundled specs, so look upward from the working directory. */
function root(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (
      existsSync(join(dir, 'tailwind/theme.css')) &&
      existsSync(join(dir, 'apps/patient/src/app'))
    )
      return dir;
    if (dirname(dir) === dir)
      throw new Error(`repo root not found above ${process.cwd()}`);
  }
}
const read = (rel: string) => readFileSync(join(root(), rel), 'utf8');
const dash = (file: string) => read(`apps/patient/src/app/dashboard/${file}`);

/** Every `sd-cta-row` element in a template: its class list and the markup inside it. */
function rows(src: string): { cls: string; body: string }[] {
  const out: { cls: string; body: string }[] = [];
  const open = /<div class="([^"]*\bsd-cta-row\b[^"]*)"[^>]*>/g;
  for (let m: RegExpExecArray | null; (m = open.exec(src));) {
    // Walk to the matching </div>.
    const tag = /<div\b[^>]*>|<\/div>/g;
    tag.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = src.length;
    for (let t: RegExpExecArray | null; (t = tag.exec(src));) {
      depth += t[0] === '</div>' ? -1 : 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    out.push({ cls: m[1], body: src.slice(m.index + m[0].length, end) });
  }
  return out;
}

/** The card CTA sites (file -> how many rows). */
const SITES: Record<string, number> = {
  'dashboard-home.ts': 1, // Upcoming Appointment: View All | Join
  'specialist-card.ts': 1, // View Profile | Book Consultation (Find a specialist + public list)
  'appointment-details.ts': 4, // proposal footer, actions card, document request, Shared-with footer
  'appointments.ts': 1, // follow-up proposal cards (3 CTAs)
  'lab-request-details.ts': 1, // Accept request | Decline
  'access-requests-banner.ts': 1, // Review request | Decline
  'sharing-doctors-panel.ts': 1, // per-doctor actions
};

describe('card CTAs guard', () => {
  it('the sd-cta-row utility: wrapping flex row, equal flex basis from --sd-cta-min, full-width one-line buttons', () => {
    const css = read('tailwind/theme.css').replace(/\r\n/g, '\n');
    const block = css.match(/@utility sd-cta-row \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(block).toContain('display: flex;');
    expect(block).toContain('flex-wrap: wrap;');
    expect(block).toMatch(/gap: var\(--sd-cta-gap, 0\.75rem\);/);
    // Same basis + grow for every child: equal columns on a line, a lone child fills its line.
    expect(block).toMatch(
      /& > \* \{\s*flex: 1 1 var\(--sd-cta-min, 8rem\);\s*\}/,
    );
    // The real buttons (raw, links, or inside <sd-button>) fill their column on one line.
    expect(block).toMatch(
      /& > :is\(a, button\),\s*& > sd-button > button \{[^}]*width: 100%;[^}]*white-space: nowrap;/,
    );
    // No reordering: focus order is always what is on screen (LD-C).
    expect(block).not.toMatch(/order|wrap-reverse|row-reverse/);
  });

  for (const [file, count] of Object.entries(SITES)) {
    it(`${file}: its card CTAs use sd-cta-row with a width knob, buttons only inside`, () => {
      const found = rows(dash(file));
      expect(found.length).toBe(count);
      for (const { cls, body } of found) {
        expect(cls).toMatch(/\[--sd-cta-min:\d+(\.\d+)?rem\]/);
        // Each child is a column: hint text and links that aren't CTAs live outside the row.
        expect(body).not.toMatch(/<p\b/);
        expect(body).toMatch(/<sd-button\b|<button\b|<a\b/);
        // The row sets the gap; a gap-* utility would fight it (use [--sd-cta-gap:...]).
        expect(cls).not.toMatch(/(^|\s)gap-/);
      }
    });
  }

  it('no card CTA site keeps the old hugging row (a plain flex row holding sd-buttons)', () => {
    const hug =
      /<div class="([^"]*)"[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*(?:@if \([^)]*\) \{\s*)?<sd-button/g;
    for (const file of Object.keys(SITES)) {
      for (const m of dash(file).matchAll(hug)) {
        const cls = m[1].split(/\s+/);
        // A centred row is an error / empty state's retry, not a card's CTAs.
        if (
          cls.includes('flex') &&
          !cls.includes('flex-col') &&
          !cls.includes('justify-center')
        ) {
          expect(cls, `${file}: ${m[1]}`).toContain('sd-cta-row');
        }
      }
    }
  });

  it('two-CTA sd-buttons in a row ask for [full] (the inner button fills even without the row rule)', () => {
    for (const file of [
      'dashboard-home.ts',
      'specialist-card.ts',
      'appointments.ts',
      'lab-request-details.ts',
    ]) {
      for (const { body } of rows(dash(file))) {
        for (const tag of body.match(/<sd-button\b[^>]*>/g) ?? [])
          expect(tag, file).toContain('[full]="true"');
      }
    }
  });

  it('appointment details: long Join labels became a caption read with the button (LD-A)', () => {
    const src = dash('appointment-details.ts');
    expect(src).not.toContain('Join now — your doctor is in the call');
    expect(src).not.toContain('Join now — it has started');
    expect(src).toContain('id="pat-join-reason"');
    expect(src).toContain(
      `[describedBy]="joinReason(v) ? 'pat-join-reason' : null"`,
    );
  });

  it('page headers: the Book CTA hugs one line and shortens to "Book" in a narrow row', () => {
    for (const file of ['appointments.ts', 'appointment-details.ts']) {
      const src = dash(file);
      expect(src).toContain(
        '<div class="@container flex flex-wrap items-start justify-between gap-4">',
      );
      expect(src).toContain(
        '<sd-button size="sm" class="shrink-0 whitespace-nowrap" (click)="book()">',
      );
      expect(src).toContain(
        '<span>Book<span class="@max-xl:sr-only"> Consultation</span></span>',
      );
    }
  });
});

describe('one-line Pay label price (LD-B)', () => {
  it('whole naira drop the kobo; anything else reads as priceLabel', async () => {
    const { priceShort } = await import('./dashboard/follow-up');
    expect(priceShort('15000')).toBe('₦15,000');
    expect(priceShort(15000.5)).toBe('₦15,000.50');
    expect(priceShort('0')).toBe('Free');
  });
});
