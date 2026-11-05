import { HttpEventType, HttpHeaderResponse, HttpResponse } from '@angular/common/http';
import {
  UPLOAD_STARTED,
  uploadFinishingText,
  uploadProgressFrom,
  uploadProgressText,
} from './upload-progress';

describe('uploadProgressFrom', () => {
  it('reads the share sent from upload events', () => {
    expect(uploadProgressFrom({ type: HttpEventType.UploadProgress, loaded: 25, total: 100 })).toEqual({
      percent: 25,
      finishing: false,
    });
    expect(uploadProgressFrom({ type: HttpEventType.UploadProgress, loaded: 0, total: 100 })).toEqual(UPLOAD_STARTED);
  });

  it('only says 100% once every byte is out, and then it is finishing', () => {
    // 99.6% is not "done": no rounding up while bytes are still going.
    expect(uploadProgressFrom({ type: HttpEventType.UploadProgress, loaded: 996, total: 1000 })).toEqual({
      percent: 99,
      finishing: false,
    });
    expect(uploadProgressFrom({ type: HttpEventType.UploadProgress, loaded: 1000, total: 1000 })).toEqual({
      percent: 100,
      finishing: true,
    });
  });

  it('has no percent when the browser cannot tell the size (no total, or 0)', () => {
    expect(uploadProgressFrom({ type: HttpEventType.UploadProgress, loaded: 512 })).toEqual({ percent: null, finishing: false });
    expect(uploadProgressFrom({ type: HttpEventType.UploadProgress, loaded: 0, total: 0 })).toEqual({ percent: null, finishing: false });
  });

  it('is finishing once the server starts to answer', () => {
    expect(uploadProgressFrom(new HttpHeaderResponse({ status: 201 }))).toEqual({ percent: 100, finishing: true });
    expect(uploadProgressFrom({ type: HttpEventType.DownloadProgress, loaded: 10 })).toEqual({ percent: 100, finishing: true });
  });

  it('says nothing for Sent, the response or a user event', () => {
    expect(uploadProgressFrom({ type: HttpEventType.Sent })).toBeNull();
    expect(uploadProgressFrom(new HttpResponse({ status: 201, body: {} }))).toBeNull();
    expect(uploadProgressFrom({ type: HttpEventType.User })).toBeNull();
  });
});

describe('uploadProgressText / uploadFinishingText', () => {
  it('shows the percent, "Uploading…" for an unknown size and "Finishing…" once sent', () => {
    expect(uploadProgressText({ percent: 42, finishing: false })).toBe('42%');
    expect(uploadProgressText({ percent: null, finishing: false })).toBe('Uploading…');
    expect(uploadProgressText({ percent: 100, finishing: true })).toBe('Finishing…');
  });

  it('names what was sent', () => {
    expect(uploadFinishingText('scan.pdf')).toBe('scan.pdf is sent. Finishing up…');
    expect(uploadFinishingText('  ')).toBe('The file is sent. Finishing up…');
  });
});
