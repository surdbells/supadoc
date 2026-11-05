import { firstValueFrom, of } from 'rxjs';
import { SAVE_REVOKE_MS, saveBlob, saveSignedLink } from './save-file';

describe('save-file', () => {
  const realUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let made: string[];
  let revoked: string[];
  let clicked: { href: string; download: string; rel: string; connected: boolean }[];

  beforeEach(() => {
    made = [];
    revoked = [];
    clicked = [];
    URL.createObjectURL = () => {
      const u = `blob:http://localhost/${made.length + 1}`;
      made.push(u);
      return u;
    };
    URL.revokeObjectURL = (u: string) => void revoked.push(u);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, rel: this.rel, connected: this.isConnected });
    });
  });

  afterEach(() => {
    URL.createObjectURL = realUrl.create;
    URL.revokeObjectURL = realUrl.revoke;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clicks a same-origin blob: anchor with a download name, removes it, and revokes after 30 s', () => {
    vi.useFakeTimers();
    saveBlob(new Blob(['%PDF']), 'Lab report.pdf');
    expect(clicked).toEqual([{ href: 'blob:http://localhost/1', download: 'Lab report.pdf', rel: 'noopener', connected: true }]);
    expect(document.querySelector('a[download]')).toBeNull();
    vi.advanceTimersByTime(SAVE_REVOKE_MS - 1);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual(['blob:http://localhost/1']);
  });

  it('saveSignedLink fetches the link through the given function and never makes an anchor with the API URL', async () => {
    const fetch = vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' })));
    await firstValueFrom(saveSignedLink(of({ url: '/api/public/prescriptions/file?token=d', filename: 'GVM-RX-1.pdf' }), fetch));
    expect(fetch).toHaveBeenCalledWith('/api/public/prescriptions/file?token=d');
    expect(clicked).toHaveLength(1);
    expect(clicked[0].href.startsWith('blob:')).toBe(true);
    expect(clicked[0].download).toBe('GVM-RX-1.pdf');
    expect(clicked.some((c) => c.href.includes('/api/'))).toBe(false);
  });
});
