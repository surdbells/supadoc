import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The pill contract (tailwind/pills.css): geometry on the scale with a whole-pixel
 * centred line box, the shared base (touch band, focus, disabled, motion), the
 * import location, the context variables, and WCAG contrast of every state in
 * every context, computed from the real sources (theme.css tokens, the pills.css
 * contexts and the patient dark block in apps/patient/src/styles.css). All three
 * files are declared inputs of this test (project.json).
 */
const ROOT = resolve(__dirname, '../../../../../..');
const read = (p: string) =>
  readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const uncomment = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const PILLS = read('tailwind/pills.css');
/** pills.css without its comments, whitespace collapsed (formatting-proof): what the rules below look at. */
const CODE = uncomment(PILLS).replace(/\s+/g, ' ');
const THEME = read('tailwind/theme.css');
const PATIENT = uncomment(read('apps/patient/src/styles.css'));
const APPS = ['doctor', 'patient', 'backoffice', 'onboarding'] as const;

// ---------- CSS helpers ----------

/** The text between the brace at `open` and its partner. */
function block(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error('unbalanced');
}
/** The body of `@utility <name> { … }`. */
function utility(name: string): string {
  const start = CODE.indexOf(`@utility ${name} {`);
  if (start < 0) throw new Error(`no @utility ${name}`);
  return block(CODE, CODE.indexOf('{', start));
}
/** Top-level declarations of a block (nested rules and their selectors dropped). */
function decls(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let depth = 0;
  let buf = '';
  for (const ch of uncomment(body)) {
    if (ch === '{') {
      if (depth === 0) buf = '';
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) buf = '';
    } else if (depth === 0) {
      if (ch === ';') {
        const m = /^\s*([-\w]+)\s*:\s*([\s\S]+?)\s*$/.exec(buf);
        if (m) out[m[1]] = m[2].replace(/\s+/g, ' ');
        buf = '';
      } else buf += ch;
    }
  }
  return out;
}
/** Declarations of the block that follows the `nth` occurrence of `selector` (which ends with `{`). */
function rule(css: string, selector: string, nth = 0): Record<string, string> {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = css.indexOf(selector, at + 1);
    if (at < 0) throw new Error(`no rule ${selector} #${nth}`);
  }
  return decls(block(css, at + selector.length - 1));
}
const token = (name: string): string => {
  const m = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(THEME);
  if (!m) throw new Error(`no token --${name}`);
  return m[1].replace(/\/\*.*?\*\//g, '').trim();
};
const px = (v: string): number => {
  const t = v.trim();
  const m = /^var\(--([-\w]+)\)$/.exec(t);
  if (m) return px(token(m[1]));
  if (!/^\d+(\.\d+)?px$/.test(t)) throw new Error(`not px: ${v}`);
  return parseFloat(t);
};

// ---------- colour + WCAG ----------

type Rgb = readonly [number, number, number];
interface Paint {
  readonly rgb: Rgb;
  readonly a: number;
}
function paint(value: string, vars: Record<string, string> = {}): Paint {
  const v = value.trim();
  const ref = /^var\(--([-\w]+)(?:,\s*([^)]+))?\)$/.exec(v);
  if (ref) {
    if (ref[1].startsWith('color-')) return paint(token(ref[1]));
    if (vars[`--${ref[1]}`]) return paint(vars[`--${ref[1]}`], vars);
    if (ref[2]) return paint(ref[2], vars);
    throw new Error(`unresolved ${v}`);
  }
  if (v === '#fff' || v === 'white') return { rgb: [255, 255, 255], a: 1 };
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = (i: number) => parseInt(hex[1].slice(i, i + 2), 16);
    return { rgb: [n(0), n(2), n(4)], a: 1 };
  }
  const fn =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(
      v,
    );
  if (fn)
    return {
      rgb: [+fn[1], +fn[2], +fn[3]],
      a: fn[4] === undefined ? 1 : +fn[4],
    };
  throw new Error(`Unsupported colour: ${value}`);
}
const over = (top: Paint, bottom: Rgb): Rgb => {
  const mix = (i: 0 | 1 | 2) => top.rgb[i] * top.a + bottom[i] * (1 - top.a);
  return [mix(0), mix(1), mix(2)];
};
const lum = ([r, g, b]: Rgb): number => {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** Text `fg` on fill `bg` (may be translucent) laid over the opaque `surface`. */
function textRatio(
  fg: string,
  bg: string | null,
  surface: Rgb,
  vars: Record<string, string>,
): number {
  const under = bg ? over(paint(bg, vars), surface) : surface;
  return contrast(over(paint(fg, vars), under), under);
}

// ---------- contexts ----------

const ROOT_CTX = rule(CODE, '.sd-call .sd-rx-zone {', 0);
const CALL_CTX = rule(CODE, '.ws-band {');
const LIGHT_CALL_EXTRA = rule(CODE, ".sd-call[data-theme='light'] {");
/** The second `… .sd-call .sd-rx-zone {` block: the literal hairlines and shadows. */
const LITERAL_CTX = rule(CODE, '.sd-call .sd-rx-zone {', 1);
const PATIENT_DARK = (() => {
  const at = PATIENT.indexOf("html[data-theme='dark'] {\n    --sd-pill-fg");
  if (at < 0) throw new Error('no patient dark pill block');
  return decls(block(PATIENT, PATIENT.indexOf('{', at)));
})();

const hex = (h: string): Rgb => paint(h).rgb;
const CONTEXTS: ReadonlyArray<{
  name: string;
  vars: Record<string, string>;
  track: Rgb;
  surfaces: readonly Rgb[];
}> = [
  {
    name: 'portal light',
    vars: ROOT_CTX,
    track: hex('#f1f9ff'),
    surfaces: [hex('#f1f9ff'), hex('#fcfcfc')],
  },
  {
    name: 'patient dark',
    vars: { ...ROOT_CTX, ...PATIENT_DARK },
    track: hex('#111a24'),
    surfaces: [hex('#111a24'), hex('#161f2b'), hex('#0d141c')],
  },
  {
    name: 'cockpit dark',
    vars: { ...ROOT_CTX, ...CALL_CTX },
    track: over(paint('rgb(255 255 255 / 0.03)'), hex('#0a1628')),
    surfaces: [
      over(paint('rgb(255 255 255 / 0.03)'), hex('#0a1628')),
      hex('#0a1628'),
    ],
  },
  {
    name: 'cockpit light',
    vars: { ...ROOT_CTX, ...LIGHT_CALL_EXTRA, ...LITERAL_CTX },
    track: hex('#ffffff'),
    surfaces: [hex('#ffffff'), hex('#eef4f8')],
  },
];

describe('pills contract (tailwind/pills.css)', () => {
  it('starts with the @source exclusion of the audit gallery', () => {
    expect(PILLS.split('\n')[0].trim()).toBe("@source not '../tools';");
  });

  it('is imported by each web app right after theme.css; theme.css does not import it', () => {
    for (const app of APPS) {
      const css = read(`apps/${app}/src/styles.css`);
      const theme = css.indexOf("@import '../../../tailwind/theme.css';");
      const pills = css.indexOf("@import '../../../tailwind/pills.css';");
      expect(theme).toBeGreaterThan(0);
      expect(pills).toBeGreaterThan(theme);
      // nothing but a comment between them
      expect(
        css
          .slice(theme, pills)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .trim(),
      ).toBe("@import '../../../tailwind/theme.css';");
    }
    expect(THEME).not.toMatch(/pills\.css/);
  });

  it('registers every knob as a non-inheriting custom property', () => {
    const knobs = [
      'h',
      'px',
      'pis',
      'gap',
      'fs',
      'lh',
      'ls',
      'fw',
      'chip-icon',
      'chip-ring',
      'track-py',
      'track-px',
      'track-r',
      'wrap-r',
      'track-wrap',
      'track-overflow',
    ];
    for (const k of knobs)
      expect(CODE).toMatch(
        new RegExp(
          `@property --sd-${k} \\{ syntax: '\\*'; inherits: false; \\}`,
        ),
      );
    // The touch knobs inherit (a track or row sets them for its pills).
    expect(PILLS).not.toMatch(/@property --sd-hit-/);
  });

  // ---------- geometry ----------
  const SIZES = [
    { u: 'sd-pill-s', h: 26, lh: 'caption', fw: 600 },
    { u: 'sd-pill-c', h: 28, lh: 'caption', fw: 600 },
    { u: 'sd-pill-m', h: 30, lh: 'body-sm', fw: 600 },
    { u: 'sd-pill-f', h: 34, lh: 'body-sm', fw: 500 },
    { u: 'sd-pill-n', h: 38, lh: 'body-sm', fw: 500 },
    { u: 'sd-pill-l', h: 40, lh: 'body', fw: 600 },
  ] as const;

  it('every pill size: on the scale, (height − line-height) even, weight through the --sd-fw knob', () => {
    for (const s of SIZES) {
      const d = decls(utility(s.u));
      expect(d['height']).toBe(`var(--sd-h, ${s.h}px)`);
      const lh = px(`var(--text-${s.lh}--line-height)`);
      expect((s.h - lh) % 2).toBe(0);
      expect(s.h - lh).toBeGreaterThanOrEqual(0);
      expect(d['font']).toMatch(
        new RegExp(
          `^var\\(--sd-fw, ${s.fw}\\) var\\(--text-${s.lh}\\) / var\\(--text-${s.lh}--line-height\\) var\\(--font-sans\\)$`,
        ),
      );
    }
    // The page tab bar's phone size (30 / 22) and the dock (36 / 18).
    expect(utility('sd-pill-l')).toMatch(
      /@media \(width < 40rem\) \{[^}]*height: var\(--sd-h, 30px\);[^}]*var\(--sd-fw, 600\) var\(--text-body-sm\) \/ var\(--text-body-sm--line-height\)/,
    );
    const dock = decls(utility('sd-pill-dock'));
    expect(dock['height']).toBe('36px');
    expect(dock['font']).toMatch(/^var\(--sd-fw, 600\) var\(--text-caption\)/);
    expect((36 - px('var(--text-caption--line-height)')) % 2).toBe(0);
  });

  it('chips and counts: on the scale with an even (height − line-height); every pill radius is 9999px', () => {
    const chip = decls(utility('sd-chip'));
    expect(chip['height']).toBe('var(--sd-h, 26px)');
    expect(chip['line-height']).toBe(
      'var(--sd-lh, var(--text-caption--line-height))',
    );
    expect((26 - px('var(--text-caption--line-height)')) % 2).toBe(0);
    const lg = decls(utility('sd-chip-lg'));
    expect([lg['--sd-h'], lg['--sd-lh']]).toEqual([
      '30px',
      'var(--text-body-sm--line-height)',
    ]);
    expect((30 - px(lg['--sd-lh'])) % 2).toBe(0);
    const xs = decls(utility('sd-chip-xs'));
    expect([xs['--sd-h'], xs['--sd-lh']]).toEqual(['20px', '16px']);
    const count = decls(utility('sd-count'));
    expect(count['height']).toBe('var(--sd-h, 16px)');
    expect(count['font']).toBe(
      '600 var(--sd-fs, 10px) / var(--sd-h, 16px) var(--font-sans)',
    );
    expect(decls(utility('sd-count-lg'))['--sd-h']).toBe('20px');
    for (const u of ['sd-pill', 'sd-chip', 'sd-count', 'sd-track-dock'])
      expect(decls(utility(u))['border-radius']).toBe('9999px');
    expect(decls(utility('sd-track'))['border-radius']).toBe(
      'var(--sd-track-r, 9999px)',
    );
  });

  it('the shared base holds the touch band, focus, disabled and reduced-motion; no size repeats them', () => {
    const base = utility('sd-pill');
    expect(base).toMatch(
      /@media \(any-pointer: coarse\) \{\s*&::before \{[^}]*position: absolute;[^}]*inset-block: max\( ?calc\(-1 \* var\(--sd-hit-y-max, 22px\)\), ?min\(0px, calc\(50% - 22px\)\) ?\);/,
    );
    expect(base).toMatch(
      /&:focus-visible,\s*&:has\(> input:focus-visible\) \{\s*outline: 2px solid var\(--sd-pill-focus\);\s*outline-offset: 2px;/,
    );
    expect(base).toMatch(
      /&:disabled,\s*&\[aria-disabled='true'\] \{\s*cursor: not-allowed;\s*opacity: 0\.6;/,
    );
    expect(base).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*transition: none;/,
    );
    for (const s of [...SIZES.map((x) => x.u), 'sd-pill-dock']) {
      const body = utility(s);
      expect(body).not.toMatch(
        /any-pointer|::before|outline:|opacity|prefers-reduced-motion/,
      );
    }
  });

  it('never sets display on an sd-icon host (`hidden sm:inline-flex` must keep working); icon selectors add no specificity', () => {
    const iconRules = [...CODE.matchAll(/([^{};]*sd-icon[^{};]*)\{([^}]*)\}/g)];
    expect(iconRules.length).toBeGreaterThan(0);
    for (const [, selector, body] of iconRules) {
      expect(selector).toMatch(/:where\(sd-icon\)/);
      if (!/> svg/.test(selector)) expect(body).not.toMatch(/display/);
    }
  });

  it('a wrapping row opens its row gap to 18px on touch, and its bands (2 × 9) meet without overlap', () => {
    const row = utility('sd-pill-row-wrap');
    expect(decls(row)['--sd-hit-y-max']).toBe('9px');
    expect(row).toMatch(/@media \(any-pointer: coarse\) \{\s*row-gap: 18px;/);
    expect(2 * 9).toBeLessThanOrEqual(18);
  });

  it('every track inset is at least the touch band growth of the pills it holds (nothing clipped)', () => {
    // sd-track: 9 block ≥ S 9, M 7; sd-track-l: 13 ≥ L 2; loose 9 ≥ F 5; tight 5 ≥ N 3, F 5, L 2; dock 4 ≥ 4.
    expect(decls(utility('sd-track'))['padding']).toBe(
      'var(--sd-track-py, 9px) var(--sd-track-px, 17px)',
    );
    expect(decls(utility('sd-track-l'))['--sd-track-py']).toBe('13px');
    expect(decls(utility('sd-track-loose'))['padding']).toBe('9px');
    expect(decls(utility('sd-track-tight'))['padding']).toBe('5px');
    expect(decls(utility('sd-track-dock'))['padding']).toBe('4px');
    // S 9, C 8, M 7 and the phone L 7 outgrow the tight inset: such a track sets
    // [--sd-track-overflow:visible] (the pill guard's track-clips-band rule), which every track honours.
    const growth = (h: number) => (44 - h) / 2;
    expect([26, 28, 30].map(growth).every((g) => g > 5)).toBe(true);
    for (const t of ['sd-track', 'sd-track-loose', 'sd-track-tight'])
      expect(decls(utility(t))['overflow-x']).toBe(
        'var(--sd-track-overflow, auto)',
      );
  });

  it('every pill size reads the --sd-px padding knob (a dense sidebar only), defaulting to the scale', () => {
    const pad: Record<string, string> = {
      'sd-pill-s': '12px',
      'sd-pill-c': '12px',
      'sd-pill-m': '16px',
      'sd-pill-f': '16px',
      'sd-pill-n': '16px',
      'sd-pill-l': '16px',
    };
    for (const [u, v] of Object.entries(pad))
      expect(decls(utility(u))['padding-inline']).toBe(`var(--sd-px, ${v})`);
    expect(utility('sd-pill-n')).toMatch(
      /padding-inline: var\(--sd-px, 10px\)/,
    );
    expect(utility('sd-pill-l')).toMatch(
      /padding-inline: var\(--sd-px, 12px\)/,
    );
  });

  // ---------- contexts ----------
  const used = [
    ...new Set(
      [...CODE.matchAll(/var\((--sd-(?:pill|track|count|tone)-[-\w]+)\)/g)].map(
        (m) => m[1],
      ),
    ),
  ];

  it('the portal context defines every variable the utilities read', () => {
    expect(used.length).toBeGreaterThan(20);
    for (const v of used) expect(ROOT_CTX, v).toHaveProperty(v);
  });

  it('the dark cockpit re-points every variable except the ones that read on dark as they are', () => {
    const inherited = [
      '--sd-pill-solid-bg-hover',
      '--sd-count-bg',
      '--sd-count-on-bg',
    ];
    for (const v of Object.keys(ROOT_CTX))
      if (!inherited.includes(v)) expect(CALL_CTX, v).toHaveProperty(v);
  });

  it('the patient dark block only re-points known variables, in the components layer', () => {
    for (const v of Object.keys(PATIENT_DARK))
      expect(ROOT_CTX, v).toHaveProperty(v);
    expect(PATIENT).toMatch(
      /@layer components \{\s*html\[data-theme='dark'\] \{\s*--sd-pill-fg/,
    );
  });

  it('the light cockpit / paper zone use literal hairlines and shadows (the dark portal re-points haze and elevations)', () => {
    for (const v of [
      '--sd-track-line',
      '--sd-track-shadow',
      '--sd-pill-on-shadow',
    ]) {
      expect(LITERAL_CTX[v]).toBeDefined();
      expect(LITERAL_CTX[v]).not.toMatch(/var\(--color-haze\)|var\(--sd-elev/);
    }
  });

  // ---------- contrast ----------
  it('text ≥ 4.5 : 1 for every state, count and tone in every context', () => {
    const fails: string[] = [];
    const check = (ctx: string, what: string, r: number, need = 4.5) => {
      if (r < need) fails.push(`${ctx} ${what}: ${r.toFixed(2)}`);
    };
    for (const c of CONTEXTS) {
      const v = c.vars;
      for (const s of c.surfaces) {
        check(
          c.name,
          'rest (on surface)',
          textRatio(v['--sd-pill-fg'], null, s, v),
        );
        check(c.name, 'hover', textRatio(v['--sd-pill-fg-hover'], null, s, v));
        check(
          c.name,
          'filter rest',
          textRatio(v['--sd-pill-fg'], v['--sd-pill-rest-bg'], s, v),
        );
        check(
          c.name,
          'action rest',
          textRatio(v['--sd-pill-action-fg'], v['--sd-pill-rest-bg'], s, v),
        );
        check(
          c.name,
          'selected soft',
          textRatio(v['--sd-pill-on-fg'], v['--sd-pill-on-bg'], s, v),
        );
        check(
          c.name,
          'selected solid',
          textRatio(v['--sd-pill-solid-fg'], v['--sd-pill-solid-bg'], s, v),
        );
        check(
          c.name,
          'selected solid hover',
          textRatio(
            v['--sd-pill-solid-fg'],
            v['--sd-pill-solid-bg-hover'] ??
              ROOT_CTX['--sd-pill-solid-bg-hover'],
            s,
            v,
          ),
        );
        check(
          c.name,
          'count',
          textRatio(
            v['--sd-count-fg'],
            v['--sd-count-bg'] ?? ROOT_CTX['--sd-count-bg'],
            s,
            v,
          ),
        );
        check(
          c.name,
          'count on',
          textRatio(
            v['--sd-count-on-fg'],
            v['--sd-count-on-bg'] ?? ROOT_CTX['--sd-count-on-bg'],
            s,
            v,
          ),
        );
        check(
          c.name,
          'count off',
          textRatio(v['--sd-count-off-fg'], v['--sd-count-off-bg'], s, v),
        );
        check(
          c.name,
          'count in a solid pill',
          textRatio('var(--color-cerulean-dark)', 'var(--color-white)', s, v),
        );
        for (const t of [
          'neutral',
          'info',
          'success',
          'warning',
          'danger',
          'teal',
        ]) {
          check(
            c.name,
            `tone ${t}`,
            textRatio(v[`--sd-tone-${t}-fg`], v[`--sd-tone-${t}-bg`], s, v),
          );
        }
        // The modifiers read the context too (sd-seg-success / -danger are the tone pairs).
        const hot = decls(utility('sd-filter-hot'));
        const vh = { ...v, '--sd-pill-fg': v['--sd-pill-fg-hover'] };
        check(
          c.name,
          'filter-hot rest',
          textRatio(vh['--sd-pill-fg'], hot['--sd-pill-rest-bg'], s, vh),
        );
        const warn = decls(utility('sd-count-warn'));
        check(
          c.name,
          'count-warn',
          textRatio(v['--sd-pill-fg-hover'], warn['--sd-count-bg'], s, v),
        );
        expect(hot['--sd-pill-fg']).toBe('var(--sd-pill-fg-hover)');
        expect(warn['--sd-count-fg']).toBe('var(--sd-pill-fg-hover)');
        expect(decls(utility('sd-seg-danger'))['--sd-pill-on-fg']).toBe(
          'var(--sd-tone-danger-fg)',
        );
        expect(decls(utility('sd-seg-success'))['--sd-pill-on-fg']).toBe(
          'var(--sd-tone-success-fg)',
        );
      }
    }
    // The dock segment (always dark) and the overlay label over a white video frame (worst case).
    const ink = hex('#1c2b3a');
    check('dock', 'rest', textRatio('rgb(255 255 255 / 0.8)', null, ink, {}));
    check(
      'dock',
      'checked',
      textRatio('var(--color-ink)', 'var(--color-white)', ink, {}),
    );
    check(
      'overlay',
      'label',
      textRatio('#fff', 'rgb(10 22 40 / 0.7)', hex('#ffffff'), {}),
    );
    // The modifiers.
    check(
      'portal',
      'seg-success',
      textRatio(
        'var(--color-sage-ink)',
        'rgb(67 160 71 / 0.15)',
        hex('#f1f9ff'),
        {},
      ),
    );
    check(
      'portal',
      'seg-danger',
      textRatio(
        'var(--color-alert-ink)',
        'rgb(229 57 53 / 0.1)',
        hex('#f1f9ff'),
        {},
      ),
    );
    check(
      'portal',
      'filter-hot',
      textRatio('var(--color-ink)', 'rgb(242 169 0 / 0.1)', hex('#fcfcfc'), {}),
    );
    check(
      'portal',
      'count-warn',
      textRatio(
        'var(--color-ink)',
        'rgb(242 169 0 / 0.25)',
        hex('#fcfcfc'),
        {},
      ),
    );
    check(
      'portal',
      'count-alert',
      textRatio('#fff', 'var(--color-alert-ink)', hex('#fcfcfc'), {}),
    );
    expect(fails).toEqual([]);
  });

  it('focus outline and the selected ring ≥ 3 : 1 against the track and the surface (WCAG 1.4.11)', () => {
    const fails: string[] = [];
    for (const c of CONTEXTS) {
      for (const s of [c.track, ...c.surfaces]) {
        for (const k of ['--sd-pill-focus', '--sd-pill-on-ring']) {
          const r = contrast(over(paint(c.vars[k], c.vars), s), s);
          if (r < 3) fails.push(`${c.name} ${k}: ${r.toFixed(2)}`);
        }
        // A solid selected fill is its own indicator.
        const solid = contrast(
          over(paint(c.vars['--sd-pill-solid-bg'], c.vars), s),
          s,
        );
        if (solid < 3) fails.push(`${c.name} solid fill: ${solid.toFixed(2)}`);
      }
    }
    expect(fails).toEqual([]);
  });

  it('would catch a failing pair (self-test)', () => {
    // The old soft selected text on the wallet bar: cerulean on cerulean/30 over glacier.
    expect(
      textRatio(
        'var(--color-cerulean)',
        'rgb(11 98 228 / 0.3)',
        hex('#f1f9ff'),
        {},
      ),
    ).toBeLessThan(4.5);
    // The old focus ring (cerulean/40) against the glacier track.
    expect(
      contrast(
        over(paint('rgb(11 98 228 / 0.4)'), hex('#f1f9ff')),
        hex('#f1f9ff'),
      ),
    ).toBeLessThan(3);
  });
});
