import { firstValueFrom, of, throwError } from 'rxjs';
import { GENERIC_ERROR, GONE_TEXT, LINK_EXPIRED, NETWORK_ERROR, UPDATE_RELOAD, VIEW_UNAVAILABLE } from './viewer-copy';
import { viewerKind } from './viewer-kind';
import { blobSource, defaultErrorView, safeFilename, signedLinkSource, viewOnlySource } from './viewer-sources';
import type { ViewerPolicyId } from './viewer-types';

const http = (status: number, code?: string) => ({ statusCode: status, errors: code ? { code } : {} });

describe('viewer sources', () => {
  it('blobSource takes its MIME from blob.type (lower-case, no parameters)', async () => {
    const s = blobSource({ key: 'doc:1', title: 'Scan', typeLabel: 'Scan', policy: 'owner', fetch: () => of(new Blob(['x'], { type: 'Image/PNG' })) });
    const f = await firstValueFrom(s.load());
    expect(f.mime).toBe('image/png');
    expect(f.viewRef).toBeUndefined();
    expect(s.download).toBeUndefined();
  });

  it('blobSource and signedLinkSource throw on view_only (every build)', () => {
    const g = globalThis as { ngDevMode?: unknown };
    const saved = g.ngDevMode;
    g.ngDevMode = false;
    try {
      expect(() => blobSource({ key: 'k', title: 't', typeLabel: 't', policy: 'view_only', fetch: () => of(new Blob()) })).toThrow(
        'view_only sources are built with viewOnlySource',
      );
      expect(() =>
        signedLinkSource({ key: 'k', title: 't', typeLabel: 't', policy: 'view_only' as ViewerPolicyId, link: () => of({ url: '/x', filename: 'x' }), fetch: () => of(new Blob()) }),
      ).toThrow('view_only sources are built with viewOnlySource');
    } finally {
      g.ngDevMode = saved;
    }
  });

  describe('viewOnlySource', () => {
    const build = (onGone = vi.fn(), recordPrint = vi.fn(() => of({ ok: true }))) =>
      viewOnlySource({
        key: 'doc:1',
        title: 'Lab report',
        typeLabel: 'Lab report',
        view: () => of({ blob: new Blob(['%PDF'], { type: 'application/octet-stream' }), mime: 'application/pdf', viewRef: 'VM-7F3A2C1D', viewedAt: '2026-11-04T20:05:09Z' }),
        recordPrint,
        notSharedText: 'This document is no longer shared with you.',
        onGone,
      });

    it('is fixed to view_only with no download, and passes viewRef to recordPrint', async () => {
      const record = vi.fn(() => of({ ok: true }));
      const s = build(vi.fn(), record);
      expect(s.policy).toBe('view_only');
      expect(s.download).toBeUndefined();
      const f = await firstValueFrom(s.load());
      expect(f).toMatchObject({ mime: 'application/pdf', viewRef: 'VM-7F3A2C1D', viewedAt: '2026-11-04T20:05:09Z' });
      s.recordPrint?.(f).subscribe();
      expect(record).toHaveBeenCalledWith('VM-7F3A2C1D');
    });

    it('maps not_shared to gone with its text (the body calls onGone)', () => {
      const onGone = vi.fn();
      const s = build(onGone);
      expect(s.mapError?.(http(404, 'not_shared'))).toEqual({ state: 'gone', text: 'This document is no longer shared with you.', retry: false });
      expect(s.onGone).toBe(onGone);
    });

    it('a smuggled download is dropped', () => {
      const s = viewOnlySource({
        key: 'k',
        title: 't',
        typeLabel: 't',
        view: () => of({ blob: new Blob(), mime: '', viewRef: null, viewedAt: '' }),
        recordPrint: () => of(null),
        notSharedText: 'x',
        ...({ download: () => of({ blob: new Blob(), filename: 'f' }) } as object),
      });
      expect(s.download).toBeUndefined();
    });
  });

  describe('signedLinkSource', () => {
    const make = (fetchImpl: (url: string) => ReturnType<typeof of<Blob>>, canDownload?: boolean, policy: ViewerPolicyId = 'authored') => {
      const link = vi.fn((dl: boolean) => of({ url: `/api/public/prescriptions/file?token=${dl ? 'd' : 'v'}`, filename: 'GVM-RX-1.pdf' }));
      const fetch = vi.fn(fetchImpl);
      const s = signedLinkSource({ key: 'rx:1', title: 'Prescription GVM-RX-1', typeLabel: 'Prescription', extension: 'pdf', policy, link, fetch, canDownload });
      return { s, link, fetch };
    };

    it('calls link lazily, then exactly one link(false) and one fetch per load', async () => {
      const { s, link, fetch } = make(() => of(new Blob(['%PDF'], { type: 'application/pdf' })));
      expect(link).not.toHaveBeenCalled();
      const f = await firstValueFrom(s.load());
      expect(f.mime).toBe('application/pdf');
      expect(link.mock.calls).toEqual([[false]]);
      expect(fetch.mock.calls).toEqual([['/api/public/prescriptions/file?token=v']]);
    });

    it('a 410 re-links once; a second 410 gives the expired copy', async () => {
      let n = 0;
      const once = make(() => (n++ === 0 ? throwError(() => http(410)) : of(new Blob(['%PDF'], { type: 'application/pdf' }))));
      await firstValueFrom(once.s.load());
      expect(once.link).toHaveBeenCalledTimes(2);
      expect(once.fetch).toHaveBeenCalledTimes(2);

      const twice = make(() => throwError(() => http(410)));
      const err = await firstValueFrom(twice.s.load()).catch((e: unknown) => e);
      expect(twice.link).toHaveBeenCalledTimes(2);
      expect(defaultErrorView(err).text).toBe(LINK_EXPIRED);
    });

    it('download() is link(true) then one fetch, returning { blob, filename }', async () => {
      const { s, link, fetch } = make(() => of(new Blob(['%PDF'], { type: 'application/pdf' })));
      if (!s.download) throw new Error('no download');
      const out = await firstValueFrom(s.download());
      expect(link.mock.calls).toEqual([[true]]);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(out.filename).toBe('GVM-RX-1.pdf');
      expect(out.blob.size).toBeGreaterThan(0);
    });

    it('canDownload false, or a policy without download, means no download()', () => {
      expect(make(() => of(new Blob()), false).s.download).toBeUndefined();
      expect(make(() => of(new Blob()), undefined, 'staff_record').s.download).toBeUndefined();
      expect(make(() => of(new Blob()), true, 'authored_draft').s.download).toBeUndefined();
      expect(make(() => of(new Blob()), undefined, 'owner').s.download).toBeDefined();
    });
  });

  describe('defaultErrorView (§1.2.3)', () => {
    it('maps every row of the table', () => {
      expect(defaultErrorView({ status: 0 })).toEqual({ state: 'error', text: NETWORK_ERROR, retry: true });
      expect(defaultErrorView(http(404, 'not_shared'), { notSharedText: 'Not shared.' })).toEqual({ state: 'gone', text: 'Not shared.', retry: false });
      expect(defaultErrorView(http(404, 'not_shared'))).toEqual({ state: 'gone', text: GONE_TEXT, retry: false });
      expect(defaultErrorView(http(404))).toEqual({ state: 'gone', text: GONE_TEXT, retry: false });
      expect(defaultErrorView(http(410))).toEqual({ state: 'error', text: LINK_EXPIRED, retry: false });
      expect(defaultErrorView(http(415)).state).toBe('not_viewable');
      expect(defaultErrorView(http(422, 'not_viewable')).state).toBe('not_viewable');
      expect(defaultErrorView(http(409, 'update_required'))).toEqual({ state: 'reload', text: UPDATE_RELOAD, retry: false });
      expect(defaultErrorView(http(503))).toEqual({ state: 'error', text: VIEW_UNAVAILABLE, retry: true });
      expect(defaultErrorView(http(500, 'view_unavailable'))).toEqual({ state: 'error', text: VIEW_UNAVAILABLE, retry: true });
      expect(defaultErrorView(http(500))).toEqual({ state: 'error', text: GENERIC_ERROR, retry: true });
      expect(defaultErrorView(new Error('boom'))).toEqual({ state: 'error', text: GENERIC_ERROR, retry: true });
      // HttpErrorResponse shape.
      expect(defaultErrorView({ status: 404, error: { errors: { code: 'not_shared' } } }, { notSharedText: 'N' }).text).toBe('N');
    });
  });

  it('safeFilename', () => {
    expect(safeFilename('Lab report', 'pdf')).toBe('Lab report.pdf');
    expect(safeFilename('a/b\\c:d*e?f"g<h>i|j', 'pdf')).toBe('abcdefghij.pdf');
    expect(safeFilename('  many   spaces\there ', 'PDF')).toBe('many spaces here.pdf');
    expect(safeFilename('Report.pdf', 'pdf')).toBe('Report.pdf');
    expect(safeFilename('Report.PDF', '.pdf')).toBe('Report.PDF');
    expect(safeFilename('trailing dots...', 'png')).toBe('trailing dots.png');
    expect(safeFilename('', 'pdf')).toBe('document.pdf');
    expect(safeFilename('***', 'jpg')).toBe('document.jpg');
    expect(safeFilename('x'.repeat(200), 'pdf')).toBe(`${'x'.repeat(120)}.pdf`);
    expect(safeFilename('ctrl\u0007char', null)).toBe('ctrlchar');
  });

  it('viewerKind: the served type decides, never the extension', () => {
    expect(viewerKind('application/pdf; charset=binary', 'owner')).toBe('pdf');
    expect(viewerKind('image/jpeg', 'view_only')).toBe('image');
    expect(viewerKind('image/webp', 'owner')).toBe('image');
    expect(viewerKind('video/webm', 'owner')).toBe('video');
    expect(viewerKind('image/gif', 'owner')).toBe('none');
    expect(viewerKind('application/octet-stream', 'owner')).toBe('none');
    // jsdom can't play MOV: the "can't play" card; view_only never plays it.
    expect(viewerKind('video/quicktime', 'owner')).toBe('none');
    const canPlay = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    try {
      expect(viewerKind('video/quicktime', 'owner')).toBe('video');
      expect(viewerKind('video/quicktime', 'view_only')).toBe('none');
    } finally {
      canPlay.mockRestore();
    }
  });
});
