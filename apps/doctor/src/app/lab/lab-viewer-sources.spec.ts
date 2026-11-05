import type { DoctorLabResultDto } from '@supadoc/models';
import type { ViewerSource } from '@supadoc/viewer';
import { firstValueFrom, of } from 'rxjs';
import {
  isOpenableResult,
  labRequestPdfSource,
  labResultError,
  labResultSource,
  RESULT_NOT_SHARED,
  RESULT_UNAVAILABLE,
} from './lab-viewer-sources';
import { must } from './testing/lab-fixtures';

/** The source's error mapping (every lab source has one). */
function mapError(source: ViewerSource): NonNullable<ViewerSource['mapError']> {
  return must(source.mapError, 'mapError');
}

const pdf = () => new Blob(['%PDF'], { type: 'application/pdf' });
const http = (status: number, code?: string) => ({ statusCode: status, errors: code ? { code } : {} });

function result(over: Partial<DoctorLabResultDto> = {}): DoctorLabResultDto {
  return {
    id: 'res1',
    uploaded_at: '2026-11-05T10:00:00Z',
    item_ids: ['i1'],
    visible: true,
    reviewable: true,
    document: { title: 'FBC result', type_label: 'Laboratory Test Report', extension: 'pdf', size_label: '212KB', viewable: true },
    review: null,
    ...over,
  };
}

describe('lab viewer sources', () => {
  describe('labResultSource (view-only)', () => {
    function setup(over: Partial<DoctorLabResultDto> = {}) {
      const api = {
        viewResult: vi.fn(() => of({ blob: pdf(), mime: 'application/pdf', viewRef: 'VM-7F3A2C1D', viewedAt: '2026-11-05T10:05:00Z' })),
        resultPrinted: vi.fn(() => of({ status: 'success', message: 'OK', data: { recorded: true } })),
      };
      const onGone = vi.fn();
      const source = labResultSource(api as never, 'lr1', result(over), { onGone });
      return { api, onGone, source };
    }

    it('is view_only with no download, keyed per result', () => {
      const { source } = setup();
      expect(source.policy).toBe('view_only');
      expect(source.download).toBeUndefined();
      expect(source.key).toBe('labres:res1');
      expect(source.title).toBe('FBC result');
      expect(source.typeLabel).toBe('Laboratory Test Report');
      expect(source.extension).toBe('pdf');
      expect(source.sizeLabel).toBe('212KB');
      expect(source.viewable).toBe(true);
    });

    it('load() calls viewResult (lazily); Print records through resultPrinted with the view reference first', async () => {
      const { api, source } = setup();
      expect(api.viewResult).not.toHaveBeenCalled();
      const file = await firstValueFrom(source.load());
      expect(api.viewResult).toHaveBeenCalledWith('lr1', 'res1');
      expect(file.viewRef).toBe('VM-7F3A2C1D');
      await firstValueFrom(must(source.recordPrint, 'recordPrint')(file));
      expect(api.resultPrinted).toHaveBeenCalledWith('lr1', 'res1', 'VM-7F3A2C1D');
    });

    it('maps "no longer shared" to the lab copy and 503 to "Couldn\'t open the result right now"', () => {
      const { source } = setup();
      expect(mapError(source)(http(404, 'not_shared'))).toEqual({ state: 'gone', text: RESULT_NOT_SHARED, retry: false });
      expect(mapError(source)(http(503, 'view_unavailable'))).toEqual({ state: 'error', text: RESULT_UNAVAILABLE, retry: true });
      expect(mapError(source)(http(415, 'not_viewable'))?.state).toBe('not_viewable');
      expect(mapError(source)(http(409, 'update_required'))?.state).toBe('reload');
      expect(labResultError(http(500))).toBeNull();
    });

    it('calls onGone for the host to reload the request', () => {
      const { source, onGone } = setup();
      must(source.onGone, 'onGone')();
      expect(onGone).toHaveBeenCalled();
    });

    it('only visible results of an openable type are opened', () => {
      expect(isOpenableResult(result())).toBe(true);
      expect(isOpenableResult(result({ visible: false, document: null }))).toBe(false);
      expect(isOpenableResult(result({ document: { ...must(result().document, 'document'), extension: 'docx', viewable: false } }))).toBe(false);
    });
  });

  describe('labRequestPdfSource (signed link)', () => {
    it('opens through link(false) + fileBlob, downloads through link(true)', async () => {
      const api = {
        link: vi.fn((_id: string, dl: boolean) =>
          of({ status: 'success', message: 'OK', data: { url: `/api/public/lab-requests/file?token=${dl ? 'd' : 'v'}`, expires_at: '', filename: 'GVM-REQ-20261104-00012.pdf' } }),
        ),
        fileBlob: vi.fn(() => of(pdf())),
      };
      const source = labRequestPdfSource(api as never, { id: 'lr1', number: 'GVM-REQ-20261104-00012' });
      expect(source.policy).toBe('authored');
      expect(source.key).toBe('lab:lr1');
      expect(source.title).toBe('Lab request GVM-REQ-20261104-00012');
      expect(source.typeLabel).toBe('Lab request');
      await firstValueFrom(source.load());
      expect(api.link).toHaveBeenCalledWith('lr1', false);
      expect(api.fileBlob).toHaveBeenCalledWith({ url: '/api/public/lab-requests/file?token=v' });
      const saved = await firstValueFrom(must(source.download, 'download')());
      expect(api.link).toHaveBeenLastCalledWith('lr1', true);
      expect(saved.filename).toBe('GVM-REQ-20261104-00012.pdf');
    });
  });
});
