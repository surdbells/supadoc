import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '../icons/icons';
import { AlertComponent, type AlertTone } from './alert';

/**
 * WCAG 2.2 AA for every alert tone: text ≥ 4.5:1 (1.4.3) and the icon ≥ 3:1
 * (1.4.11) on the alert's own tint, in light mode and in the patient app's dark
 * mode. Colours come from the real sources, not copies: the light tokens from
 * tailwind/theme.css, the dark values from the `html[data-theme='dark'] …`
 * remaps in apps/patient/src/styles.css (a class with no remap keeps its light
 * value). The tint is composited over the two surfaces an alert sits on: the
 * card (`bg-white`) and the page (`bg-glacier`) — the doctor call cockpit's
 * prescribing/follow-up "paper" zone is `bg-glacier` too. Both files are declared
 * inputs of this test (project.json).
 */
const ROOT = resolve(__dirname, '../../../../../..');
const THEME = readFileSync(resolve(ROOT, 'tailwind/theme.css'), 'utf8');
const PATIENT = readFileSync(
  resolve(ROOT, 'apps/patient/src/styles.css'),
  'utf8',
);

type Rgb = readonly [number, number, number];
interface Paint {
  readonly rgb: Rgb;
  readonly a: number;
}
type Mode = 'light' | 'dark';

// ---------- WCAG helpers ----------

function parseColour(value: string): Paint {
  const v = value.trim();
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

/** Source-over compositing of `top` onto an opaque `bottom`. */
function over(top: Paint, bottom: Rgb): Rgb {
  const mix = (i: 0 | 1 | 2) => top.rgb[i] * top.a + bottom[i] * (1 - top.a);
  return [mix(0), mix(1), mix(2)];
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------- Token / remap resolution ----------

function isColourToken(name: string): boolean {
  return new RegExp(`--color-${name}\\s*:`).test(THEME);
}

function token(name: string): Rgb {
  const m = new RegExp(`--color-${name}\\s*:\\s*(#[0-9a-f]{6})`, 'i').exec(
    THEME,
  );
  if (!m) throw new Error(`--color-${name} is not in tailwind/theme.css`);
  return parseColour(m[1]).rgb;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The patient dark-mode value a utility class is re-pointed to, if any. */
function darkRemap(
  cls: string,
  prop: 'color' | 'background-color',
): Paint | undefined {
  const selector = '.' + cls.replace(/\//g, '\\/'); // as written in CSS: .bg-frost\/50
  const re = new RegExp(
    `html\\[data-theme='dark'\\] ${escapeRe(selector)}\\s*[,{][^}]*?(?<![-\\w])${prop}:\\s*([^;]+);`,
  );
  const m = re.exec(PATIENT);
  return m ? parseColour(m[1]) : undefined;
}

/** A `bg-*` / `text-*` palette class (with optional /opacity) in the given mode. */
function paint(cls: string, mode: Mode): Paint {
  const m = /^(bg|text)-([a-z-]+?)(?:\/(\d+))?$/.exec(cls);
  if (!m) throw new Error(`Not a palette class: ${cls}`);
  if (mode === 'dark') {
    const remap = darkRemap(cls, m[1] === 'bg' ? 'background-color' : 'color');
    if (remap) return remap;
  }
  return { rgb: token(m[2]), a: m[3] ? +m[3] / 100 : 1 };
}

const SURFACES: Record<Mode, { card: Rgb; page: Rgb }> = {
  light: { card: token('white'), page: token('glacier') },
  dark: {
    card: over(paint('bg-white', 'dark'), [0, 0, 0]),
    page: over(paint('bg-glacier', 'dark'), [0, 0, 0]),
  },
};

/** [light card, light page, dark card, dark page] for `text` on the `bg` tint. */
function ratios(bg: string, text: string): [number, number, number, number] {
  const on = (mode: Mode, surface: Rgb) => {
    const tint = over(paint(bg, mode), surface);
    return contrast(over(paint(text, mode), tint), tint);
  };
  return [
    on('light', SURFACES.light.card),
    on('light', SURFACES.light.page),
    on('dark', SURFACES.dark.card),
    on('dark', SURFACES.dark.page),
  ];
}

// ---------- The table ----------

interface Row {
  readonly tone: AlertTone;
  readonly role: 'alert' | 'status';
  readonly bg: string;
  readonly text: string;
  /** Recorded ratios, [light card, light page, dark card, dark page]. */
  readonly after: readonly [number, number, number, number];
}

/*
 * Before the fix (47762f9) each tone drew its text in the bare tone colour on
 * its own tint. Recorded for history only, not re-checked (the base tones may
 * change without affecting the alert). [light card, light page, dark card,
 * dark page]:
 *   error   text-alert     3.59  3.46  6.75  7.56   fail
 *   success text-sage      2.90  2.81  7.23  8.18   fail (icon < 3:1 too)
 *   info    text-cerulean  4.52  4.44  7.09  7.99   fail on the page
 *   warning text-warning   1.83  1.77  6.93  7.87   fail (icon < 3:1 too)
 * Dark mode is unchanged: the patient app re-points each base tone and its ink
 * class to the same light shade.
 */
const TABLE: readonly Row[] = [
  {
    tone: 'error',
    role: 'alert',
    bg: 'bg-alert/10',
    text: 'text-alert-ink',
    after: [5.57, 5.38, 6.75, 7.56],
  },
  {
    tone: 'success',
    role: 'status',
    bg: 'bg-sage/10',
    text: 'text-sage-ink',
    after: [6.92, 6.69, 7.23, 8.18],
  },
  {
    tone: 'info',
    role: 'status',
    bg: 'bg-frost/50',
    text: 'text-cerulean-dark',
    after: [6.08, 5.97, 7.09, 7.99],
  },
  {
    tone: 'warning',
    role: 'alert',
    bg: 'bg-warning/10',
    text: 'text-warning-ink',
    after: [5.39, 5.21, 6.93, 7.87],
  },
];

const TEXT_MIN = 4.5;

/** A computed ratio matches its 2-decimal record in the table. */
function expectRecorded(actual: number, recorded: number): void {
  expect(Math.abs(actual - recorded)).toBeLessThan(0.01);
}
const ICON_MIN = 3;

function render(tone: AlertTone) {
  const fixture = TestBed.createComponent(AlertComponent);
  fixture.componentRef.setInput('tone', tone);
  fixture.detectChanges();
  const box: HTMLElement = fixture.nativeElement.querySelector('div');
  const icon: HTMLElement = fixture.nativeElement.querySelector('sd-icon');
  return { box, icon };
}

/** The palette `bg-*` / `text-*` classes on an element (not `text-body-sm` etc.). */
function colourClasses(el: Element, kind: 'bg' | 'text'): string[] {
  return [...el.classList].filter((c) => {
    const m = /^(bg|text)-([a-z-]+?)(?:\/\d+)?$/.exec(c);
    return !!m && m[1] === kind && isColourToken(m[2]);
  });
}

describe('AlertComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AlertComponent],
      providers: [provideSupadocIcons()],
    }).compileComponents();
  });

  it('reads the dark surfaces from the patient styles', () => {
    expect(SURFACES.dark.card).toEqual([22, 31, 43]); // #161f2b
    expect(SURFACES.dark.page).toEqual([13, 20, 28]); // #0d141c
  });

  describe.each(TABLE)('$tone', (row) => {
    it(`renders ${row.bg} + ${row.text} with role=${row.role}; the icon inherits the text colour`, () => {
      const { box, icon } = render(row.tone);
      expect(colourClasses(box, 'bg')).toEqual([row.bg]);
      expect(colourClasses(box, 'text')).toEqual([row.text]);
      expect(box.getAttribute('role')).toBe(row.role);
      expect(colourClasses(icon, 'text')).toEqual([]);
    });

    it(`text ≥ ${TEXT_MIN}:1 and icon ≥ ${ICON_MIN}:1 on its tint, light + patient dark (card / page)`, () => {
      const { box, icon } = render(row.tone);
      const [bg] = colourClasses(box, 'bg');
      const [text] = colourClasses(box, 'text');
      const iconText = colourClasses(icon, 'text')[0] ?? text;

      const got = ratios(bg, text);
      got.forEach((r, i) => expectRecorded(r, row.after[i]));
      expect(Math.min(...got)).toBeGreaterThanOrEqual(TEXT_MIN);
      expect(Math.min(...ratios(bg, iconText))).toBeGreaterThanOrEqual(
        ICON_MIN,
      );
    });
  });

  it('the WCAG helper matches known pairs', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast(token('cerulean'), [255, 255, 255])).toBeCloseTo(5.41, 2);
    expect(over({ rgb: [255, 0, 0], a: 0.5 }, [255, 255, 255])).toEqual([
      255, 127.5, 127.5,
    ]);
  });
});
