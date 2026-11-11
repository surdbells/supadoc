/*
 * Pill audit — runs IN THE PAGE (DevTools console, the in-app browser's JavaScript
 * tool, or tools/pill-audit/run.mjs through CDP Runtime.evaluate). Read-only: it
 * measures and returns JSON; it never changes the page. It logs class names and
 * text lengths only, never what a label says (labels can carry patient data).
 *
 *   pillAudit()                → { url, viewport, coarse, theme, checked, failures[], warnings[], info[], rows[] }
 *   pillAudit({ rows: false }) → without the per-element rows
 *
 * The contract (tailwind/pills.css; spec-pills §9.1):
 *  H  height is whole and on the scale (a pill allowed to wrap, white-space ≠ nowrap, is exempt)
 *  R  every corner radius ≥ height / 2 (tracks with sd-track-wrap excepted)
 *  T  the label's text box is centred (±0.5 px) and on one line
 *  P  left / right inner space symmetric (±0.5 px; skipped when the content overflows or is start-aligned);
 *     the content is the text, svgs, counts, the remove button and any painted leaf (a status dot)
 *  F  fit: an interactive pill's label stays inside the pill; a track's pills overflow it only when the
 *     track scrolls by design (info), never when they are equal segments (flex-grow) or it does not scroll
 *  I  icons centred (±0.5 px); size = --sd-icon (warning)
 *  K  coarse pointer: a ::before band ≥ 44 px tall, not clipped, and hit-testable at both ends
 *  A  sd-seg / sd-seg-solid / sd-filter / sd-filter-solid expose a state
 *  V  an sd-icon hidden by its own classes at this width has display: none
 *  N  (info) a visible non-sd element with text whose radius ≥ height / 2 (an incidental pill)
 *  C  text contrast ≥ 4.5 : 1 on the composited background (video / image ancestor = white)
 *  G  the gap to the next pill on the same row = the parent's column-gap (±0.5 px)
 *  L  (warning) a visible `.rounded-pill` that is not a skeleton or a bar
 *  O  (info; warning > 1 px) cap-height centre offset of the rendered font
 * While a modal dialog is open, only what it holds is audited (the page behind it is inert).
 */
function pillAudit(opts = {}) {
  const SCALE = [16, 20, 24, 26, 28, 30, 34, 36, 38, 40];
  const SEL = '.sd-pill, .sd-chip, .sd-count, [class*="sd-track"]';
  const LOOKS = ['sd-seg', 'sd-seg-solid', 'sd-filter', 'sd-filter-solid'];
  const SELECTED =
    '[aria-pressed="true"],[aria-selected="true"],[aria-checked="true"],[aria-current]:not([aria-current="false"])';
  const coarse = matchMedia('(any-pointer: coarse)').matches;
  const failures = [];
  const warnings = [];
  const info = [];
  const rows = [];
  const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol + 1e-6;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return (
      cs.visibility !== 'hidden' &&
      cs.display !== 'none' &&
      !el.closest('[hidden], [aria-hidden="true"] .sr-only')
    );
  };
  // An open modal leaves the page behind it inert: audit only what the modal holds.
  let modal = null;
  try {
    modal = document.querySelector('dialog:modal');
  } catch {
    /* :modal unsupported */
  }
  const inScope = (el) =>
    (!modal || modal.contains(el)) && !el.closest('[inert]');
  const label = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = [...el.classList].filter((c) => c.startsWith('sd-')).join('.');
    const len = (el.textContent || '').trim().length;
    const where = el.closest('[data-gallery]')?.getAttribute('data-gallery');
    return `${el.tagName.toLowerCase()}${id}${cls ? '.' + cls : ''} (${len} chars)${where ? ' @' + where : ''}`;
  };
  const fail = (el, code, msg) => failures.push({ el: label(el), code, msg });
  const warn = (el, code, msg) => warnings.push({ el: label(el), code, msg });

  // ---- colour helpers (sRGB, alpha compositing) ----
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) return null;
    const p = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  });
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const backdrop = (el) => {
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(n);
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    for (const n of chain.reverse()) {
      const cs = getComputedStyle(n);
      if (
        n.tagName === 'VIDEO' ||
        n.tagName === 'IMG' ||
        (cs.backgroundImage !== 'none' && !/gradient/.test(cs.backgroundImage))
      )
        acc = { r: 255, g: 255, b: 255, a: 1 };
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0) acc = over(bg, acc);
    }
    // A video / picture drawn under an absolutely placed label (a sibling, not an ancestor): worst case white.
    if (
      el.closest('[data-on-media]') ||
      (getComputedStyle(el).position === 'absolute' &&
        el.parentElement?.querySelector(':scope > video, :scope > img'))
    )
      acc = over(
        parse(getComputedStyle(el).backgroundColor) || {
          r: 0,
          g: 0,
          b: 0,
          a: 0,
        },
        { r: 255, g: 255, b: 255, a: 1 },
      );
    return acc;
  };

  // ---- text geometry ----
  const textRects = (el) => {
    const rects = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => {
        if (!t.textContent.trim()) return NodeFilter.FILTER_REJECT;
        const p = t.parentElement;
        const skip = p.closest('.sr-only, .sd-count, .sd-chip-x');
        if (skip && skip !== el) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(t);
      for (const r of range.getClientRects()) if (r.width > 0) rects.push(r);
    }
    return rects;
  };
  const capOffset = (el, textRect, centre) => {
    const cs = getComputedStyle(el);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = ctx.measureText('H');
    const baseline =
      textRect.top +
      (textRect.height - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) /
        2 +
      m.fontBoundingBoxAscent;
    return baseline - m.actualBoundingBoxAscent / 2 - centre;
  };

  const els = [...document.querySelectorAll(SEL)].filter(
    (el) => inScope(el) && visible(el),
  );
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const classes = [...el.classList];
    const isTrack = classes.some((c) => /^sd-track/.test(c));
    const isPill = classes.includes('sd-pill');
    const wraps = isPill && cs.whiteSpace !== 'nowrap';
    const row = {
      el: label(el),
      h: +r.height.toFixed(2),
      w: +r.width.toFixed(2),
    };
    // H
    if (!isTrack && !wraps) {
      if (!near(r.height, Math.round(r.height), 0.01))
        fail(el, 'H', `height ${r.height}px is fractional`);
      else if (!SCALE.includes(Math.round(r.height)))
        fail(
          el,
          'H',
          `height ${r.height}px is not on the scale ${SCALE.join('/')}`,
        );
    }
    // R
    if (
      !classes.includes('sd-track-wrap') &&
      !(isTrack && cs.flexWrap === 'wrap') &&
      !classes.includes('sd-track-scroll')
    ) {
      const radii = [
        'borderTopLeftRadius',
        'borderTopRightRadius',
        'borderBottomRightRadius',
        'borderBottomLeftRadius',
      ].map((k) => parseFloat(cs[k]));
      if (radii.some((x) => x + 0.01 < r.height / 2))
        fail(el, 'R', `radius ${radii.join('/')} < height/2 (${r.height / 2})`);
    }
    // F: a track overflows only when it scrolls by design (§4.2).
    if (isTrack && !classes.includes('sd-track-wrap')) {
      const spill = el.scrollWidth - el.clientWidth;
      if (spill > 1) {
        const segments = [...el.children].some(
          (c) =>
            c.classList.contains('sd-pill') &&
            visible(c) &&
            parseFloat(getComputedStyle(c).flexGrow) > 0,
        );
        if (segments || cs.overflowX === 'visible')
          fail(
            el,
            'F',
            `pills overflow the track by ${spill}px (${segments ? 'equal segments' : 'it does not scroll'})`,
          );
        else info.push({ el: label(el), code: 'F', scrolls: spill });
      }
    }
    if (!isTrack) {
      const centre = r.top + r.height / 2;
      // T
      const tr = textRects(el);
      if (tr.length) {
        const top = Math.min(...tr.map((x) => x.top));
        const bottom = Math.max(...tr.map((x) => x.bottom));
        const lines = new Set(tr.map((x) => Math.round(x.top + x.height / 2)));
        if (lines.size > 1 && !wraps)
          fail(el, 'T', 'label wraps onto more than one line');
        const tc = (top + bottom) / 2;
        row.textDy = +(tc - centre).toFixed(2);
        if (!near(tc, centre))
          fail(el, 'T', `text box centre off by ${row.textDy}px`);
        row.capDy = +capOffset(el, tr[0], centre).toFixed(2);
        info.push({ el: label(el), code: 'O', capDy: row.capDy });
        if (Math.abs(row.capDy) > 1)
          warn(
            el,
            'O',
            `cap-height centre ${row.capDy}px from the pill centre (font metrics)`,
          );
      }
      // P (content union: text + svg + counts + the remove button)
      const parts = [...tr];
      for (const s of el.querySelectorAll(
        ':scope svg, :scope .sd-count, :scope .sd-chip-x',
      )) {
        if (
          s.closest('.sr-only') ||
          (s.tagName.toLowerCase() === 'svg' && s.closest('.sd-chip-x'))
        )
          continue;
        const b = s.getBoundingClientRect();
        if (b.width) parts.push(b);
      }
      // A painted leaf (e.g. a status dot before the label) is content, not padding.
      for (const s of el.querySelectorAll(':scope *')) {
        if (s.children.length || s.closest('svg, .sr-only, .sd-chip-x'))
          continue;
        const scs = getComputedStyle(s);
        const paint = parse(scs.backgroundColor);
        if (!((paint && paint.a > 0) || parseFloat(scs.borderTopWidth) > 0))
          continue;
        const b = s.getBoundingClientRect();
        if (b.width) parts.push(b);
      }
      // F: an interactive pill never cuts or spills its label (§4.7).
      if (isPill && !wraps && tr.length) {
        const spill = Math.max(
          r.left - Math.min(...tr.map((x) => x.left)),
          Math.max(...tr.map((x) => x.right)) - r.right,
        );
        if (spill > 0.5)
          fail(el, 'F', `label runs ${spill.toFixed(1)}px past the pill`);
      }
      const justify = cs.justifyContent;
      if (
        parts.length &&
        !/start|left|normal/.test(justify) &&
        el.scrollWidth <= el.clientWidth + 1
      ) {
        const left = Math.min(...parts.map((x) => x.left)) - r.left;
        const right = r.right - Math.max(...parts.map((x) => x.right));
        row.padL = +left.toFixed(2);
        row.padR = +right.toFixed(2);
        // A removable chip's ✕ sits 4px into the padding by design (margin-inline-end: -4px).
        const xShift = el.querySelector(':scope > .sd-chip-x') ? 4 : 0;
        if (!near(left - xShift, right))
          fail(el, 'P', `inner space L ${row.padL} ≠ R ${row.padR}`);
      }
      // I
      const iconSize = parseFloat(cs.getPropertyValue('--sd-icon')) || null;
      for (const s of el.querySelectorAll(
        ':scope > svg, :scope > sd-icon > svg, :scope > span > sd-icon > svg',
      )) {
        const ir = s.getBoundingClientRect();
        if (!ir.width) continue;
        if (!near(ir.top + ir.height / 2, centre))
          fail(
            el,
            'I',
            `icon centre off by ${(ir.top + ir.height / 2 - centre).toFixed(2)}px`,
          );
        const own =
          s.parentElement === el || s.closest('sd-icon')?.parentElement === el;
        if (iconSize && own && !near(ir.width, iconSize, 0.01))
          warn(el, 'I', `icon ${ir.width}px ≠ scale ${iconSize}px`);
      }
      // V: an icon hidden by its own classes at this width must not show (patient nav, phones).
      for (const ic of el.querySelectorAll(':scope > sd-icon')) {
        const hiddenByClass =
          ic.classList.contains('hidden') &&
          !(
            innerWidth >= 640 &&
            [...ic.classList].some((c) =>
              /^sm:(inline-)?flex|^sm:block|^sm:inline/.test(c),
            )
          );
        if (hiddenByClass && getComputedStyle(ic).display !== 'none')
          fail(
            el,
            'V',
            'an icon hidden by its classes at this width is showing',
          );
      }
      // K
      const interactive =
        el.matches(
          'button, a, label, [role="tab"], [role="radio"], [tabindex]',
        ) && isPill;
      if (interactive && coarse) {
        const b = getComputedStyle(el, '::before');
        if (b.content === 'none' || b.position !== 'absolute')
          fail(el, 'K', 'no touch band (::before)');
        else {
          // pillAudit({ scroll: true }): bring an off-screen pill into view so it can be hit-tested.
          let rr = r;
          if (opts.scroll && (rr.top < 0 || rr.bottom > innerHeight)) {
            el.scrollIntoView({
              block: 'center',
              inline: 'nearest',
              behavior: 'instant',
            });
            rr = el.getBoundingClientRect();
          }
          // ::before offsets are from the padding box (inside a look-alike's 1px border).
          const t = parseFloat(b.top) + parseFloat(cs.borderTopWidth);
          const btm = parseFloat(b.bottom) + parseFloat(cs.borderBottomWidth);
          const hitTop = rr.top + t;
          const hitBottom = rr.bottom - btm;
          row.hitH = +(hitBottom - hitTop).toFixed(2);
          if (row.hitH + 0.01 < 44)
            fail(el, 'K', `touch band ${row.hitH}px < 44px`);
          for (let p = el.parentElement; p; p = p.parentElement) {
            const pcs = getComputedStyle(p);
            // Only a box that clips vertically can cut the band (overflow-x: clip on body does not).
            if (pcs.overflowY !== 'visible' && pcs.overflowY !== '') {
              const pr = p.getBoundingClientRect();
              if (
                hitTop < pr.top + parseFloat(pcs.borderTopWidth) - 0.5 ||
                hitBottom > pr.bottom - parseFloat(pcs.borderBottomWidth) + 0.5
              )
                fail(el, 'K', `touch band clipped by ${label(p)}`);
              break;
            }
          }
          const x = rr.left + rr.width / 2;
          for (const y of [hitTop + 1, hitBottom - 1]) {
            if (y < 0 || y > innerHeight) continue;
            const hit = document.elementFromPoint(x, y);
            if (hit && hit !== el && !el.contains(hit))
              fail(
                el,
                'K',
                `point ${Math.round(y - rr.top)}px from the top hits ${label(hit)}`,
              );
          }
        }
      }
      // A
      if (classes.some((c) => LOOKS.includes(c))) {
        const radio = el.querySelector(
          ':scope > input[type="radio"], :scope > input[type="checkbox"]',
        );
        const nav =
          el.tagName === 'A' &&
          el.closest('nav') &&
          el.parentElement?.querySelector(
            '[aria-current]:not([aria-current="false"])',
          );
        const hasState =
          el.matches(
            '[aria-pressed],[aria-selected],[aria-checked],[aria-current]',
          ) ||
          radio ||
          nav;
        if (!hasState)
          fail(el, 'A', 'selectable pill without an exposed state');
        row.selected =
          el.matches(SELECTED) || !!el.querySelector(':scope > input:checked');
      }
      // C
      const fg = parse(cs.color);
      if (fg && tr.length) {
        const bg = backdrop(el);
        const c = ratio(over(fg, bg), bg);
        row.contrast = +c.toFixed(2);
        const disabled =
          el.matches(':disabled, [aria-disabled="true"]') ||
          !!el.closest(':disabled');
        if (c < 4.5 && !disabled)
          fail(el, 'C', `text contrast ${c.toFixed(2)} < 4.5`);
      }
    }
    // G
    const parent = el.parentElement;
    const pcs = parent ? getComputedStyle(parent) : null;
    const gap = pcs ? parseFloat(pcs.columnGap) : NaN;
    if (pcs && !Number.isNaN(gap) && pcs.display.includes('flex') && !isTrack) {
      const next = el.nextElementSibling;
      if (next && next.matches(SEL) && visible(next)) {
        const nr = next.getBoundingClientRect();
        if (
          near(nr.top + nr.height / 2, r.top + r.height / 2, 1) &&
          !near(nr.left - r.right, gap)
        )
          fail(el, 'G', `gap ${(nr.left - r.right).toFixed(2)} ≠ ${gap}`);
      }
    }
    rows.push(row);
  }
  // L
  for (const el of document.querySelectorAll('.rounded-pill')) {
    if (!inScope(el) || !visible(el)) continue;
    if (
      el.matches('.sd-shimmer') ||
      /\bh-(1\.5|2)\b|\bh-full\b/.test(el.className)
    )
      continue;
    warn(el, 'L', 'unmigrated rounded-pill');
  }
  // N: incidental pills (not sd-*), listed only.
  for (const el of document.querySelectorAll(
    'button, a, span, li, div, label',
  )) {
    if (el.closest(SEL) || !inScope(el) || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (
      r.height > 44 ||
      r.height < 12 ||
      !(el.textContent || '').trim() ||
      el.children.length > 3
    )
      continue;
    const rad = parseFloat(getComputedStyle(el).borderTopLeftRadius);
    if (rad + 0.01 >= r.height / 2 && Math.abs(r.width - r.height) > 2)
      info.push({
        el: label(el),
        code: 'N',
        h: +r.height.toFixed(2),
        cls: String(el.className).slice(0, 120),
      });
  }
  return {
    url: location.href,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    coarse,
    theme: document.documentElement.dataset.theme || 'light',
    checked: els.length,
    failures,
    warnings,
    info: opts.rows === false ? info.filter((x) => x.code === 'N') : info,
    ...(opts.rows === false ? {} : { rows }),
  };
}
