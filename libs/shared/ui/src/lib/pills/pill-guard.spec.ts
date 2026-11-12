import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The pill guard: every pill in apps/** and libs/** templates follows the one
 * standard of tailwind/pills.css (wave 2 item 5).
 *
 * MODE: 'report' lists the offenders and fails only its self-tests; 'fail' (since
 * the two call pages were converted) makes every offender a failure. App templates
 * are declared inputs of this test (project.json).
 */
const MODE: 'report' | 'fail' = 'fail';

const ROOT = resolve(__dirname, '../../../../../..');
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'api',
  'vendor',
  'var',
  'out-tsc',
  '.angular',
  'lint-fixtures',
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|html)$/.test(name) && !/\.spec\.ts$/.test(name) ? [p] : [];
  });
}

// ---------- vocabulary ----------
const LOOKS = [
  'sd-seg',
  'sd-seg-solid',
  'sd-filter',
  'sd-filter-solid',
  'sd-action',
  'sd-action-tonal',
  'sd-action-primary',
  'sd-action-current',
];
const SELECTABLE = ['sd-seg', 'sd-seg-solid', 'sd-filter', 'sd-filter-solid'];
const SIZES = /^sd-pill-(s|c|m|f|n|l|dock)$/;
/** A class list that holds a pill, chip, count or track. */
const OWNED =
  /(^|\s)(sd-pill|sd-pill-[a-z]+|sd-chip|sd-count|sd-track(-[a-z]+)?)(\s|$)/;
const COLOURS =
  /^(?:(?:hover|active|focus|group-hover):)?(bg|text)-(?!caption\b|body\b|body-sm\b|body-lg\b|h[1-5]\b|center\b|left\b|right\b|\[\d)/;
/** Utilities that fight what an sd-* utility sets (Tailwind orders by property, not by source). */
const FORBIDDEN: ReadonlyArray<RegExp> = [
  /^min-h-/,
  /^h-\d/,
  /^px-/,
  /^py-/,
  /^text-(caption|body|body-sm|body-lg|\[\d+px\])$/,
  /^font-(normal|medium|semibold|bold)$/,
  /^leading-/,
  /^rounded(-|$)/,
  /^border(-|$)/,
  /^ring-/,
  /^inset-ring/,
  /^focus:outline-none$/,
  /^focus-visible:ring/,
];
/** Colour utilities a look-less pill (LD2: a converted look-alike button) keeps. */
const LOOKLESS_KEEPS =
  /^(?:(?:hover|active):)?(bg-|text-(?!caption\b|body)|border(-|$)|shadow-)/;
/** A count's cut-out ring (it sits on an icon button) is allowed. */
const COUNT_CUTOUT = /^ring-(2|glacier|white)$/;
/** rounded-pill allowed on these shapes: skeletons and bars. */
const ROUNDED_OK = (cls: string) =>
  /\bsd-shimmer\b/.test(cls) ||
  (/\bh-(1\.5|2)\b/.test(cls) && /\boverflow-hidden\b/.test(cls)) ||
  /\bh-full\b/.test(cls);

interface Offence {
  readonly at: string;
  readonly rule: string;
  readonly detail: string;
}

/**
 * Allowed offences, each with its reason. An entry that matches nothing any more
 * fails a self-test below, so the list never goes stale.
 */
const ALLOW: ReadonlyArray<{
  readonly file: string;
  readonly rule: string;
  readonly detail: RegExp;
  readonly why: string;
}> = [
  {
    file: 'apps/patient/src/app/call/call-join.ts',
    rule: 'rounded-pill',
    detail: /\babsolute\b.*\bbg-abyss\/70\b.*\bbackdrop-blur\b/,
    why: "the lobby preview's capsule of 44px icon buttons over the video: not a pill (spec-pills §8, role f-icon)",
  },
];
const usedAllow = new Set<number>();
function allowed(o: Offence): boolean {
  const file = o.at.replace(/:\d+$/, '');
  const i = ALLOW.findIndex(
    (a) => a.file === file && a.rule === o.rule && a.detail.test(o.detail),
  );
  if (i >= 0) usedAllow.add(i);
  return i >= 0;
}

/** Checks one class list (a static `class` attribute or a class-string constant). */
function checkClassList(cls: string, at: string, out: Offence[]): void {
  const tokens = cls
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !t.includes('${'));
  if (tokens.includes('rounded-pill') && !ROUNDED_OK(cls))
    out.push({ at, rule: 'rounded-pill', detail: cls });
  if (
    tokens.some((t) => /^sd-tone-/.test(t)) &&
    !tokens.some((t) => t === 'sd-chip' || t === 'sd-count')
  )
    out.push({ at, rule: 'tone-off-chip', detail: cls });
  if (!OWNED.test(cls)) return;
  const unprefixed = tokens.filter(
    (t) =>
      !/^(sm|md|lg|xl|2xl|max-sm|max-md|max-lg|roomy):/.test(t) &&
      !/^\[--sd-/.test(t),
  );
  const isPill = tokens.includes('sd-pill');
  const look = tokens.find((t) => LOOKS.includes(t));
  const isCount = tokens.includes('sd-count');
  /** A nested track scroller sets only its block padding: inline padding (focus-ring room) is its own. */
  const scrollerOnly =
    tokens.includes('sd-track-scroll') &&
    !tokens.some((t) =>
      /^sd-(pill|chip|count)$|^sd-track(-(?!scroll)[a-z]+)?$/.test(t),
    );
  for (const t of unprefixed) {
    if (!FORBIDDEN.some((r) => r.test(t))) continue;
    if (isPill && !look && LOOKLESS_KEEPS.test(t)) continue;
    if (isCount && COUNT_CUTOUT.test(t)) continue;
    if (scrollerOnly && /^px-/.test(t)) continue;
    out.push({ at, rule: 'owned-utility', detail: `${t} in "${cls}"` });
  }
  // A nested scroller clips at its padding box: it needs inline room for the 4px focus ring.
  if (scrollerOnly && !tokens.some((t) => /^px-/.test(t)))
    out.push({
      at,
      rule: 'scroller-ring-room',
      detail: `no inline padding (-mx-2 px-2) in "${cls}"`,
    });
  if (isPill && !look) {
    for (const t of unprefixed)
      if (/^font-(normal|medium|semibold|bold)$/.test(t))
        out.push({
          at,
          rule: 'weight-knob',
          detail: `${t}: set the weight through the --sd-fw knob`,
        });
  }
  if (look) {
    for (const t of unprefixed)
      if (COLOURS.test(t))
        out.push({ at, rule: 'look-colour', detail: `${t} beside ${look}` });
  }
  if (isCount) {
    for (const t of unprefixed)
      if (COLOURS.test(t)) out.push({ at, rule: 'count-colour', detail: t });
  }
  // A size needs the base under the same variant prefix.
  for (const t of tokens) {
    const m = /^((?:[\w-]+:)*)(sd-pill-[a-z]+)$/.exec(t);
    if (m && SIZES.test(m[2]) && !tokens.includes(`${m[1]}sd-pill`))
      out.push({ at, rule: 'size-without-base', detail: t });
  }
}

/** Class-string constants of one source: `const NAME = '…'` (one literal). */
function constantsOf(text: string, exportedOnly = false): Map<string, string> {
  const map = new Map<string, string>();
  const re = exportedOnly
    ? /\bexport\s+const\s+([A-Z][A-Z0-9_]*)\s*=\s*(['"`])([^'"`$]*)\2\s*;/g
    : /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(['"`])([^'"`$]*)\2\s*;/g;
  for (const m of text.matchAll(re)) map.set(m[1], m[3]);
  return map;
}

/** `${NAME}` in a class attribute → the constant's classes (the file's own first, then a unique export). */
function expand(
  cls: string,
  local: Map<string, string>,
  shared: Map<string, Set<string>>,
): string {
  return cls.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name: string) => {
    if (local.has(name)) return local.get(name) as string;
    const values = shared.get(name);
    return values && values.size === 1 ? [...values][0] : whole;
  });
}

/** The markup between an element's start tag (ending at `from`) and its matching end tag. */
function innerOf(text: string, from: number, tag: string): string {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1]) depth--;
    else if (!m[0].endsWith('/>')) depth++;
    if (depth === 0) return text.slice(from, m.index);
  }
  return text.slice(from);
}

/** Checks the template elements of one file and every class-string literal in it. */
function checkSource(
  text: string,
  file: string,
  out: Offence[],
  shared: Map<string, Set<string>> = new Map(),
): void {
  const line = (index: number) => text.slice(0, index).split('\n').length;
  const local = constantsOf(text);
  // Names that hold a tone outside a template (`cls: 'sd-tone-x'`, `const T = 'sd-tone-x'`): a
  // binding that reads one of them puts a tone on its element, so that element must be a chip.
  const toneNames = new Set<string>();
  for (const m of text.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*[:=]\s*(['"`])\s*sd-tone-[a-z]+\s*\2/g,
  ))
    toneNames.add(m[1]);
  const readsTone = (bound: string) =>
    [...toneNames].some((n) =>
      new RegExp(`(^|[^\\w$])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(bound),
    );
  // 1. Template elements.
  for (const m of text.matchAll(
    /<([a-z][\w-]*)\b((?:[^<>"']|"[^"]*"|'[^']*')*)>/g,
  )) {
    const [whole, tag, attrs] = m;
    const at = `${file}:${line(m.index ?? 0)}`;
    const raw = /(?:^|\s)class="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const stat = expand(raw, local, shared);
    const bound = [...attrs.matchAll(/\[(?:class|ngClass)\]="([^"]*)"/g)]
      .map((b) => b[1])
      .join(' ');
    if (stat) checkClassList(stat, at, out);
    const tokens = stat.split(/\s+/);
    // A tight track (5px inset) clips the bands of S, C, M and the phone L (growth 9 / 8 / 7 / 7).
    if (
      tokens.includes('sd-track-tight') &&
      !tokens.includes('[--sd-track-overflow:visible]') &&
      !tokens.includes('sd-track-wrap') &&
      /\bsd-pill-(s|c|m|l)\b/.test(
        innerOf(text, (m.index ?? 0) + whole.length, tag),
      )
    )
      out.push({
        at,
        rule: 'track-clips-band',
        detail: `S/C/M/L pills in a tight track that clips: "${stat}"`,
      });
    if (tokens.some((t) => SELECTABLE.includes(t))) {
      const aria =
        /\[attr\.aria-(pressed|selected|checked|current)\]|\baria-(pressed|selected|checked|current)=/.test(
          attrs,
        );
      const navLink = tag === 'a' && /routerLink/.test(attrs);
      const radioLabel =
        tag === 'label' &&
        /^\s*(?:<!--[\s\S]*?-->\s*)*<input\b[^>]*type="(radio|checkbox)"/.test(
          text.slice((m.index ?? 0) + whole.length),
        );
      if (!aria && !navLink && !radioLabel)
        out.push({ at, rule: 'state-not-exposed', detail: stat });
    }
    if (
      (/(^|[\s'"])sd-tone-/.test(bound) || readsTone(bound)) &&
      !tokens.some((t) => t === 'sd-chip' || t === 'sd-count')
    )
      out.push({ at, rule: 'tone-off-chip', detail: `[class]="${bound}"` });
    if (bound && tokens.includes('sd-count')) {
      for (const lit of bound.matchAll(/'([^']*)'/g))
        for (const t of lit[1].split(/\s+/))
          if (t && !/^sd-count-/.test(t))
            out.push({ at, rule: 'count-binding', detail: t });
    }
    if (bound && tokens.some((t) => SELECTABLE.includes(t))) {
      for (const lit of bound.matchAll(/'([^']*)'/g))
        for (const t of lit[1].split(/\s+/))
          if (COLOURS.test(t))
            out.push({ at, rule: 'look-binding', detail: t });
    }
  }
  // 2. Class-string literals outside attributes (tokens, computed classes).
  // A literal that is one tone alone is a tone value (a map entry or a [class] branch); the
  // template pass checks that the element it lands on is a chip (a literal branch, or a binding
  // that reads the map key or constant holding it: toneNames).
  for (const m of text.matchAll(/'([^'\n]*\bsd-[a-z][^'\n]*)'/g))
    if (!/^\s*sd-tone-[a-z]+\s*$/.test(m[1]))
      checkClassList(m[1], `${file}:${line(m.index ?? 0)}`, out);
  // 3. rounded-pill in a single-quoted or one-line template literal (class attributes are pass 1's).
  for (const m of text.matchAll(
    /(['`])([^"'`\n]*\brounded-pill\b[^"'`\n]*)\1/g,
  )) {
    if (!ROUNDED_OK(m[2]))
      out.push({
        at: `${file}:${line(m.index ?? 0)}`,
        rule: 'rounded-pill',
        detail: m[2],
      });
  }
}

function scan(): Offence[] {
  const out: Offence[] = [];
  const sources = ['apps', 'libs']
    .flatMap((top) => files(resolve(ROOT, top)))
    .map((f) => ({ f, text: readFileSync(f, 'utf8').replace(/\r\n/g, '\n') }));
  const shared = new Map<string, Set<string>>();
  for (const s of sources)
    for (const [k, v] of constantsOf(s.text, true))
      (shared.get(k) ?? shared.set(k, new Set()).get(k))?.add(v);
  for (const s of sources)
    checkSource(s.text, relative(ROOT, s.f).split('\\').join('/'), out, shared);
  // One offence per place and rule.
  const seen = new Set<string>();
  return out.filter((o) => {
    if (allowed(o)) return false;
    const k = `${o.at}|${o.rule}|${o.detail}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

describe('pill guard', () => {
  const offences = scan();

  it(`every pill follows tailwind/pills.css (mode: ${MODE})`, () => {
    if (offences.length) {
      const byRule = offences.reduce<Record<string, number>>(
        (a, o) => ((a[o.rule] = (a[o.rule] ?? 0) + 1), a),
        {},
      );
      console.info(
        `pill guard (${MODE}): ${offences.length} offences ${JSON.stringify(byRule)}\n` +
          offences
            .map((o) => `  ${o.rule.padEnd(18)} ${o.at}  ${o.detail}`)
            .join('\n'),
      );
    }
    if (MODE === 'fail') expect(offences).toEqual([]);
    else expect(Array.isArray(offences)).toBe(true);
  });

  it('every allowlist entry still matches an offence (no stale entry)', () => {
    expect(ALLOW.filter((_, i) => !usedAllow.has(i)).map((a) => a.file)).toEqual(
      [],
    );
  });

  it('lists, separately, what is left outside the call pages and the files their unit converts later', () => {
    const LATER =
      /doctor-call\.ts|consultation-call\.ts|call-workspace\/|call-lab-requests\.ts|rx-composer\.ts|call\/call-join\.ts|lab-request-details\.ts/;
    const rest = offences.filter((o) => !LATER.test(o.at));
    if (rest.length)
      console.info(
        `pill guard (${MODE}), outside the call pages: ${rest.length}\n` +
          rest
            .map((o) => `  ${o.rule.padEnd(18)} ${o.at}  ${o.detail}`)
            .join('\n'),
      );
    if (MODE === 'fail') expect(rest).toEqual([]);
    else expect(rest.length).toBeGreaterThanOrEqual(0);
  });

  // ---------- self-tests ----------
  // Probe classes that no app uses are assembled at run time: Tailwind scans this file too.
  const TONE = ['sd', 'tone', 'info'].join('-');
  const check = (src: string) => {
    const out: Offence[] = [];
    checkSource(src, 'probe.ts', out);
    return out.map((o) => o.rule);
  };

  it('catches an inflated pill, a focus ring and a weight on a pill (self-test)', () => {
    expect(
      check(
        '<button class="sd-pill sd-pill-s sd-seg min-h-11 focus-visible:ring-2" aria-pressed="true">A</button>',
      ),
    ).toEqual(['owned-utility', 'owned-utility']);
    expect(
      check(
        '<button class="sd-pill sd-pill-c font-medium bg-white" (click)="x()">A</button>',
      ),
    ).toEqual(['owned-utility', 'weight-knob']);
  });

  it('catches a selectable pill with no state, or with colour classes (self-test)', () => {
    expect(
      check(
        '<button class="sd-pill sd-pill-m sd-seg" (click)="x()">A</button>',
      ),
    ).toEqual(['state-not-exposed']);
    expect(
      check(
        '<button class="sd-pill sd-pill-m sd-seg bg-frost" [attr.aria-pressed]="on">A</button>',
      ),
    ).toEqual(['look-colour']);
    expect(
      check(
        '<button class="sd-pill sd-pill-m sd-seg" [class]="on ? \'bg-frost\' : \'\'" [attr.aria-pressed]="on">A</button>',
      ),
    ).toEqual(['look-binding']);
    // A class constant with a look, used in a template without a state.
    expect(
      check(
        'const SEG = \'sd-pill sd-pill-m sd-seg\';\n<button class="${SEG}">A</button>',
      ),
    ).toEqual(['state-not-exposed']);
  });

  it('accepts the allowed forms (self-test)', () => {
    expect(
      check(
        '<button class="sd-pill sd-pill-m sd-seg flex-1 max-sm:h-auto" [attr.aria-selected]="on">A</button>',
      ),
    ).toEqual([]);
    expect(
      check(
        '<label class="sd-pill sd-pill-m sd-seg"><input type="radio" class="sr-only" /></label>',
      ),
    ).toEqual([]);
    expect(
      check('<a class="sd-pill sd-pill-n sd-seg-solid" routerLink="/x">A</a>'),
    ).toEqual([]);
    // LD2: a look-less pill keeps its own colours, border and shadow; its weight only through the knob.
    expect(
      check(
        '<button class="sd-pill sd-pill-c [--sd-fw:400] border border-haze bg-white text-cerulean shadow-control hover:border-cerulean">V</button>',
      ),
    ).toEqual([]);
    expect(
      check(
        '<span class="sd-count sd-count-lg sd-count-alert absolute ring-2 ring-glacier">3</span>',
      ),
    ).toEqual([]);
    expect(
      check('<div class="sd-shimmer h-4 w-40 rounded-pill"></div>'),
    ).toEqual([]);
  });

  it('catches a size without its base, a tone off a chip, a coloured count and a stray rounded-pill (self-test)', () => {
    expect(
      check('<button class="sd-pill-s sd-seg" aria-pressed="true">A</button>'),
    ).toEqual(['size-without-base']);
    expect(check('<span class="' + TONE + ' px-2">A</span>')).toEqual([
      'tone-off-chip',
    ]);
    expect(check('<span class="sd-count bg-cerulean">1</span>')).toEqual([
      'count-colour',
    ]);
    expect(
      check(
        '<span class="sd-count" [class]="on ? \'bg-cerulean\' : \'\'">1</span>',
      ),
    ).toEqual(['count-binding']);
    expect(
      check('<span class="rounded-pill px-2 py-0.5 text-caption">New</span>'),
    ).toEqual(['rounded-pill']);
    expect(check("const CHIP = 'rounded-pill px-2';")).toEqual([
      'rounded-pill',
    ]);
  });

  it('accepts a tone bound on a chip or kept in a tone map, and catches one bound on a non-chip (self-test)', () => {
    expect(
      check(`<span class="sd-chip" [class]="on ? '${TONE}' : 'sd-tone-danger'">A</span>`),
    ).toEqual([]);
    expect(check(`const MAP = { a: { cls: '${TONE}' } };`)).toEqual([]);
    // A tone's variables read by a look-less pill are not a tone utility.
    expect(
      check(`<b class="sd-pill sd-pill-c" [class]="on ? 'text-(--sd-tone-danger-fg)' : ''">A</b>`),
    ).toEqual([]);
    expect(
      check(`<span class="px-2" [class]="on ? '${TONE}' : ''">A</span>`),
    ).toEqual(['tone-off-chip']);
    // A tone kept in a map or a constant, read by a binding: the element must be a chip.
    const map = `const MAP = { a: { label: 'A', cls: '${TONE}' } };\nconst T = '${TONE}';\n`;
    expect(
      check(`${map}<span class="sd-chip" [class]="status(x).cls">A</span>`),
    ).toEqual([]);
    expect(
      check(`${map}<span class="inline-flex px-2" [class]="status(x).cls">A</span>`),
    ).toEqual(['tone-off-chip']);
    expect(check(`${map}<span [ngClass]="T">A</span>`)).toEqual([
      'tone-off-chip',
    ]);
    // Another key that holds no tone stays free.
    expect(
      check(`${map}<span class="px-2" [class]="status(x).clsx">A</span>`),
    ).toEqual([]);
  });

  it("catches a tight track that clips its pills' bands and a nested scroller with no ring room (self-test)", () => {
    const pill =
      '<button class="sd-pill sd-pill-s sd-seg" aria-pressed="true">A</button>';
    expect(
      check(`<div class="sd-track sd-track-tight"><div>${pill}</div></div>`),
    ).toEqual(['track-clips-band']);
    expect(
      check(
        `<div class="sd-track sd-track-tight [--sd-track-overflow:visible]">${pill}</div>`,
      ),
    ).toEqual([]);
    expect(
      check(
        '<nav class="sd-track sd-track-tight"><a class="sd-pill sd-pill-n sd-seg-solid" routerLink="/x">A</a></nav><b class="sd-pill sd-pill-s"></b>',
      ),
    ).toEqual([]);
    expect(check('<div class="sd-track-scroll min-w-0 flex-1"></div>')).toEqual(
      ['scroller-ring-room'],
    );
    expect(
      check('<div class="sd-track-scroll -mx-2 min-w-0 flex-1 px-2"></div>'),
    ).toEqual([]);
  });
});
