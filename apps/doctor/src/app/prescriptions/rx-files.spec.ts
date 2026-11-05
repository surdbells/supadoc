import { TestBed } from '@angular/core/testing';
import { DoctorApi, PrescriptionsApi } from '@supadoc/data-access';
import { DocumentViewerService, type ViewerSource } from '@supadoc/viewer';
import { firstValueFrom, Observable, of } from 'rxjs';
import { RxFiles } from './rx-files';

const API_URL = 'api/public/prescriptions/file?token=';

describe('RxFiles (prescription PDFs in the shared viewer)', () => {
  let files: RxFiles;
  let order: string[];
  let opened: Array<{ sources: ViewerSource | readonly ViewerSource[]; options: unknown }>;
  const api = {
    prescriptionLink: vi.fn((id: string, download = false) => {
      order.push(`link:${id}:${download}`);
      return of({ success: true, data: { url: API_URL + (download ? 'dl' : 'v'), filename: 'GVM-RX-1.pdf', expires_at: '' } });
    }),
  };
  const rxApi = {
    fileBlob: vi.fn((link: { url: string }) => {
      order.push(`fetch:${link.url}`);
      return of(new Blob(['%PDF'], { type: 'application/pdf' }));
    }),
  };
  const viewer = {
    open: vi.fn((sources: ViewerSource | readonly ViewerSource[], options: unknown) => {
      opened.push({ sources, options });
      return { closed: Promise.resolve(), close: () => undefined };
    }),
  };
  const one = (i = 0) => opened[i].sources as ViewerSource;

  beforeEach(() => {
    order = [];
    opened = [];
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        { provide: DoctorApi, useValue: api },
        { provide: PrescriptionsApi, useValue: rxApi },
        { provide: DocumentViewerService, useValue: viewer },
      ],
    });
    files = TestBed.inject(RxFiles);
  });

  afterEach(() => vi.restoreAllMocks());

  it('view opens the viewer with policy authored (Print and Download), never a window', async () => {
    const open = vi.spyOn(window, 'open');
    const button = document.createElement('button');
    files.view({ id: 'rx-1', number: 'GVM-RX-20261104-00001', status: 'active' }, button);
    expect(viewer.open).toHaveBeenCalledTimes(1);
    const source = one();
    expect(source.policy).toBe('authored');
    expect(source.key).toBe('rx:rx-1');
    expect(source.title).toBe('Prescription GVM-RX-20261104-00001');
    expect(source.download).toBeDefined();
    expect(opened[0].options).toEqual({ opener: button });
    // Nothing fetched until the viewer loads it: then one view link and one fetch.
    expect(order).toEqual([]);
    await firstValueFrom(source.load());
    expect(order).toEqual(['link:rx-1:false', `fetch:${API_URL}v`]);
    expect(open).not.toHaveBeenCalled();
  });

  it('preview opens the DRAFT (authored_draft, no Download) and runs resolve before prescriptionLink', async () => {
    const resolve = vi.fn(
      () =>
        new Observable<{ id: string }>((sub) => {
          order.push('resolve');
          sub.next({ id: 'rx-saved' });
          sub.complete();
        }),
    );
    files.preview('rx-draft:7', resolve);
    const source = one();
    expect(source.policy).toBe('authored_draft');
    expect(source.key).toBe('rx-draft:7');
    expect(source.download).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    await firstValueFrom(source.load());
    expect(order).toEqual(['resolve', 'link:rx-saved:false', `fetch:${API_URL}v`]);
  });

  it('download mints prescriptionLink(id, true), fetches it with fileBlob and saves it from a same-origin object URL', async () => {
    const createUrl = vi.fn(() => 'blob:https://doctor.test/abc');
    const revokeUrl = vi.fn();
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const anchors: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this);
    });
    const done = vi.fn();
    const failed = vi.fn();
    files.download('rx-1', failed, done);
    await Promise.resolve();
    expect(order).toEqual(['link:rx-1:true', `fetch:${API_URL}dl`]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute('href')).toBe('blob:https://doctor.test/abc');
    expect(anchors[0].download).toBe('GVM-RX-1.pdf');
    // Never an anchor pointing at the API.
    expect(anchors.some((a) => (a.getAttribute('href') ?? '').includes('api/public'))).toBe(false);
    expect(document.querySelector('a[href*="api/public"]')).toBeNull();
  });

  it('a failed download reports the error and saves nothing', async () => {
    rxApi.fileBlob.mockImplementationOnce(() => new Observable((sub) => sub.error({ statusCode: 410 })));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    const failed = vi.fn();
    files.download('rx-1', failed);
    await Promise.resolve();
    expect(failed).toHaveBeenCalledWith({ statusCode: 410 });
    expect(click).not.toHaveBeenCalled();
  });
});
