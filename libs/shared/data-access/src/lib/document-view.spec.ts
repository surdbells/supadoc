import { HttpHeaders, HttpResponse } from '@angular/common/http';
import { parseDocumentView, VIEW_REF_PATTERN } from './document-view';

function response(headers: Record<string, string>, body: Blob | null = new Blob(['%PDF'], { type: 'application/octet-stream' })) {
  return new HttpResponse<Blob>({ body, headers: new HttpHeaders(headers), status: 200 });
}

const NOW = () => new Date('2026-11-04T12:00:00Z');

describe('parseDocumentView', () => {
  it('reads a valid reference and time', () => {
    const v = parseDocumentView(
      response({ 'Content-Type': 'application/pdf', 'X-SD-View-Ref': 'VM-7F3A2C1D', 'X-SD-Viewed-At': '2026-11-04T20:05:09Z' }),
      NOW,
    );
    expect(v.mime).toBe('application/pdf');
    expect(v.viewRef).toBe('VM-7F3A2C1D');
    expect(v.viewedAt).toBe('2026-11-04T20:05:09Z');
  });

  it('drops a malformed reference (lower case, too short, extra text)', () => {
    for (const bad of ['vm-7f3a2c1d', 'VM-7F3A2C1', 'VM-7F3A2C1DX', 'XX-7F3A2C1D', '']) {
      expect(parseDocumentView(response({ 'X-SD-View-Ref': bad }), NOW).viewRef).toBeNull();
    }
    expect(VIEW_REF_PATTERN.test('VM-0123ABCD')).toBe(true);
  });

  it('falls back to now when X-SD-Viewed-At is missing or not a date', () => {
    expect(parseDocumentView(response({}), NOW).viewedAt).toBe('2026-11-04T12:00:00.000Z');
    expect(parseDocumentView(response({ 'X-SD-Viewed-At': 'yesterday' }), NOW).viewedAt).toBe('2026-11-04T12:00:00.000Z');
  });

  it('strips Content-Type parameters and lower-cases it; falls back to the blob type', () => {
    expect(parseDocumentView(response({ 'Content-Type': 'Image/JPEG; charset=binary' }), NOW).mime).toBe('image/jpeg');
    expect(parseDocumentView(response({}, new Blob(['x'], { type: 'image/png' })), NOW).mime).toBe('image/png');
  });

  it('an empty body gives an empty blob', () => {
    const v = parseDocumentView(response({}, null), NOW);
    expect(v.blob.size).toBe(0);
  });
});
