import { buildPrintRoot, canvasToJpeg, composePrintPage, PRINT_CLEANUP_MS, PRINT_CSS, PRINT_DPI, PRINT_DPI_OPEN } from './print-pages';

describe('print pages', () => {
  let made: string[];
  let revoked: string[];
  const env = () => ({
    createUrl: () => {
      const u = `blob:page-${made.length + 1}`;
      made.push(u);
      return u;
    },
    revokeUrl: (u: string) => revoked.push(u),
  });
  const pages = [new Blob(['1'], { type: 'image/jpeg' }), new Blob(['2'], { type: 'image/jpeg' })];
  let decode: ReturnType<typeof vi.fn>;
  const realDecode = (HTMLImageElement.prototype as { decode?: unknown }).decode;

  beforeEach(() => {
    made = [];
    revoked = [];
    decode = vi.fn(() => Promise.resolve());
    (HTMLImageElement.prototype as { decode?: unknown }).decode = decode;
  });

  afterEach(() => {
    (HTMLImageElement.prototype as { decode?: unknown }).decode = realDecode;
    document.querySelectorAll('.sd-print-root, style[data-sd-print]').forEach((n) => n.remove());
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('builds the print root and its style without innerHTML: one IMG per page', async () => {
    const prepared = await buildPrintRoot(pages, env());
    const root = document.querySelector<HTMLElement>('body > .sd-print-root');
    expect(root).toBe(prepared.root);
    expect(root?.getAttribute('aria-hidden')).toBe('true');
    expect(Array.from(root?.children ?? []).map((c) => c.tagName)).toEqual(['IMG', 'IMG']);
    expect(Array.from(root?.querySelectorAll('img') ?? []).map((i) => [i.getAttribute('src'), i.alt])).toEqual([
      ['blob:page-1', ''],
      ['blob:page-2', ''],
    ]);
    const style = document.querySelector('style[data-sd-print]');
    expect(style?.textContent).toBe(PRINT_CSS);
    expect(style?.textContent).toContain('body > :not(.sd-print-root) { display: none !important; }');
    prepared.cleanup();
  });

  it('never prints before every image has decoded', async () => {
    const held: (() => void)[] = [];
    const release = () => held.forEach((r) => r());
    decode.mockImplementation(() => new Promise<void>((r) => held.push(r)));
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    let prepared: Awaited<ReturnType<typeof buildPrintRoot>> | null = null;
    const pending = buildPrintRoot(pages, env()).then((p) => (prepared = p));
    await Promise.resolve();
    expect(prepared).toBeNull();
    expect(print).not.toHaveBeenCalled();
    release();
    await pending;
    const ready = prepared as Awaited<ReturnType<typeof buildPrintRoot>> | null;
    if (!ready) throw new Error('Not prepared');
    ready.print();
    expect(print).toHaveBeenCalledTimes(1);
    ready.cleanup();
  });

  it('a failed decode cleans up and rejects', async () => {
    decode.mockImplementation(() => Promise.reject(new Error('decode')));
    await expect(buildPrintRoot(pages, env())).rejects.toThrow('decode');
    expect(document.querySelector('.sd-print-root')).toBeNull();
    expect(document.querySelector('style[data-sd-print]')).toBeNull();
    expect(revoked).toEqual(['blob:page-1', 'blob:page-2']);
  });

  it('removes the root and the style and revokes the URLs on afterprint', async () => {
    vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const prepared = await buildPrintRoot(pages, env());
    prepared.print();
    window.dispatchEvent(new Event('afterprint'));
    expect(document.querySelector('.sd-print-root')).toBeNull();
    expect(document.querySelector('style[data-sd-print]')).toBeNull();
    expect(revoked).toEqual(['blob:page-1', 'blob:page-2']);
  });

  it('…or 60 s after printing at the latest', async () => {
    vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const prepared = await buildPrintRoot(pages, env());
    vi.useFakeTimers();
    prepared.print();
    vi.advanceTimersByTime(PRINT_CLEANUP_MS - 1);
    expect(document.querySelector('.sd-print-root')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.querySelector('.sd-print-root')).toBeNull();
    expect(revoked.length).toBe(2);
  });

  it('canvasToJpeg asks for a JPEG at 0.85', async () => {
    const canvas = document.createElement('canvas');
    const toBlob = vi
      .spyOn(canvas, 'toBlob')
      .mockImplementation((cb: BlobCallback) => cb(new Blob(['x'], { type: 'image/jpeg' })));
    const blob = await canvasToJpeg(canvas);
    expect(blob.type).toBe('image/jpeg');
    expect(toBlob.mock.calls[0].slice(1)).toEqual(['image/jpeg', 0.85]);
  });

  describe('composePrintPage (dpi / footer per policy)', () => {
    const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
    const real = { getContext: proto['getContext'], toBlob: proto['toBlob'] };
    let ctx: { fillRect: ReturnType<typeof vi.fn>; fillText: ReturnType<typeof vi.fn>; [k: string]: unknown };
    beforeEach(() => {
      ctx = {
        font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'start', textBaseline: 'alphabetic',
        save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), strokeText: vi.fn(),
        fillRect: vi.fn(), fillText: vi.fn(), measureText: vi.fn((t: string) => ({ width: t.length * 7 })),
      };
      proto['getContext'] = () => ctx;
      proto['toBlob'] = (cb: BlobCallback) => cb(new Blob(['j'], { type: 'image/jpeg' }));
    });
    afterEach(() => {
      proto['getContext'] = real.getContext;
      proto['toBlob'] = real.toBlob;
    });

    it('view_only prints at 150 DPI, every other policy at 200', () => {
      expect(PRINT_DPI).toBe(150);
      expect(PRINT_DPI_OPEN).toBe(200);
    });

    it('with a footer and a watermark: the band under the picture and the text burned in', async () => {
      const src = document.createElement('canvas');
      await composePrintPage(src, 1000, 1400, { dpr: 1.5625, watermark: 'Dr Ada Obi · VideoMed', footer: 'Printed by Dr Ada Obi' });
      expect(ctx.fillRect.mock.calls.some((c) => c[1] === 1400)).toBe(true);
      expect(ctx.fillText.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['Dr Ada Obi · VideoMed', 'Printed by Dr Ada Obi']));
    });

    it('without them (other policies): a plain page, no band, no text', async () => {
      const src = document.createElement('canvas');
      await composePrintPage(src, 1000, 1400, { dpr: 2.08, watermark: null, footer: null });
      expect(ctx.fillRect.mock.calls).toEqual([[0, 0, 1000, 1400]]);
      expect(ctx.fillText).not.toHaveBeenCalled();
    });
  });
});
