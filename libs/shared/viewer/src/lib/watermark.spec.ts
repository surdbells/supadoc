import { drawPrintFooter, drawWatermark, overlayLines, printFooterText, watermarkFontPx, watermarkText } from './watermark';

/** A 2D context that records what was drawn. */
function fakeContext() {
  return {
    font: '',
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    strokeStyle: '' as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn((t: string) => ({ width: t.length * 7 })),
  };
}

describe('watermark', () => {
  const base = { viewerName: 'Dr Ada Obi', viewedAt: '2026-11-04T20:05:09Z', timeZone: 'America/Chicago' };

  it('names the viewer, the time on their clock, VideoMed and the reference — never the patient', () => {
    expect(watermarkText({ ...base, viewRef: 'VM-7F3A2C1D' })).toBe(
      'Dr Ada Obi · Wed 4 Nov 2026, 2:05 PM CST · VideoMed · Ref VM-7F3A2C1D',
    );
    expect(watermarkText({ ...base, viewRef: null })).toBe('Dr Ada Obi · Wed 4 Nov 2026, 2:05 PM CST · VideoMed');
  });

  it('tiles the text diagonally across the canvas (fillText) at −30°', () => {
    const ctx = fakeContext();
    const text = watermarkText({ ...base, viewRef: 'VM-7F3A2C1D' });
    drawWatermark(ctx as unknown as CanvasRenderingContext2D, 1200, 1600, { text, cssWidth: 600, dpr: 2 });
    expect(ctx.rotate).toHaveBeenCalledWith((-30 * Math.PI) / 180);
    expect(ctx.fillText.mock.calls.length).toBeGreaterThan(4);
    expect(ctx.fillText.mock.calls.every((c) => c[0] === text)).toBe(true);
    expect(ctx.strokeText).toHaveBeenCalled();
    expect(ctx.font).toBe('600 27px Poppins, Arial, sans-serif');
    expect(ctx.fillStyle).toBe('rgba(84, 110, 122, 0.14)');
    expect(ctx.restore).toHaveBeenCalled();
  });

  it('is denser and stronger on paper', () => {
    const screen = fakeContext();
    const paper = fakeContext();
    const o = { text: 'Dr Ada Obi · VideoMed', cssWidth: 800, dpr: 1.5625 };
    drawWatermark(screen as unknown as CanvasRenderingContext2D, 1240, 1754, o);
    drawWatermark(paper as unknown as CanvasRenderingContext2D, 1240, 1754, { ...o, density: 'print' });
    expect(paper.fillText.mock.calls.length).toBeGreaterThan(screen.fillText.mock.calls.length);
    expect(paper.fillStyle).toBe('rgba(84, 110, 122, 0.18)');
  });

  it('font size: max(12, width / 45) CSS px × dpr', () => {
    expect(watermarkFontPx(300, 1)).toBe(12);
    expect(watermarkFontPx(900, 2)).toBe(40);
  });

  it('the printed footer, with and without a reference', () => {
    const w = { viewerName: 'Dr Ada Obi', timeZone: 'America/Chicago', printedAt: '2026-11-04T20:05:09Z' };
    expect(printFooterText({ ...w, viewRef: 'VM-7F3A2C1D' })).toBe(
      'Printed by Dr Ada Obi · Wed 4 Nov 2026, 2:05 PM CST · VideoMed Ref VM-7F3A2C1D · Confidential patient record. Do not share.',
    );
    expect(printFooterText({ ...w, viewRef: null })).toBe(
      'Printed by Dr Ada Obi · Wed 4 Nov 2026, 2:05 PM CST · VideoMed · Confidential patient record. Do not share.',
    );
    const ctx = fakeContext();
    drawPrintFooter(ctx as unknown as CanvasRenderingContext2D, 1240, 1754, 44, 'Printed by …');
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 1754, 1240, 44);
    expect(ctx.fillText).toHaveBeenCalledWith('Printed by …', 620, 1776);
  });

  it('the video overlay repeats the text', () => {
    const lines = overlayLines('Dr Ada Obi · VideoMed', 3);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('Dr Ada Obi · VideoMed');
  });
});
