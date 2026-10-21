import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import type { ApiError } from '@supadoc/models';
import { openBlobDocument } from './clinical-document.util';

interface FakeTab {
  document: Document;
  location: { href: string };
  close: ReturnType<typeof vi.fn>;
}

function fakeTab(): FakeTab {
  const doc = document.implementation.createHTMLDocument('tab');
  doc.write = vi.fn();
  return { document: doc, location: { href: '' }, close: vi.fn() };
}

describe('openBlobDocument', () => {
  let tab: FakeTab;
  const created = vi.fn(() => 'blob:mock-url');
  const revoked = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    created.mockClear();
    revoked.mockClear();
  });

  it('opens the placeholder tab on the click and points it at the blob once it arrives', () => {
    openBlobDocument(of(new Blob(['%PDF'], { type: 'application/pdf' })));
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(tab.location.href).toBe('blob:mock-url');
    vi.advanceTimersByTime(120_000);
    expect(revoked).toHaveBeenCalledWith('blob:mock-url');
  });

  it("calls onError(404, 'not_shared') and closes the placeholder tab", () => {
    const onError = vi.fn();
    const err: ApiError = {
      statusCode: 404,
      message: 'This document is no longer shared with you.',
      errors: { code: 'not_shared' },
    };
    openBlobDocument(throwError(() => err), { onError });
    expect(onError).toHaveBeenCalledWith(404, 'not_shared');
    expect(tab.close).toHaveBeenCalled();
    expect(tab.document.body.textContent).toBe('');
  });

  it('reads the code from a raw HttpErrorResponse too, and null when there is none', () => {
    const onError = vi.fn();
    openBlobDocument(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 503,
            error: { message: 'Could not open the document right now.', errors: { code: 'view_unavailable' } },
          }),
      ),
      { onError },
    );
    expect(onError).toHaveBeenLastCalledWith(503, 'view_unavailable');

    openBlobDocument(throwError(() => ({ statusCode: 0, message: 'offline' })), { onError });
    expect(onError).toHaveBeenLastCalledWith(0, null);
  });

  it('without onError, shows the API message in the tab as text (as before)', () => {
    const err: ApiError = {
      statusCode: 404,
      message: '<b>This document is no longer shared with you.</b>',
      errors: { code: 'not_shared' },
    };
    openBlobDocument(throwError(() => err));
    expect(tab.close).not.toHaveBeenCalled();
    const box = tab.document.body.firstElementChild as HTMLElement;
    expect(box.textContent).toBe('<b>This document is no longer shared with you.</b>');
    expect(box.querySelector('b')).toBeNull();
  });
});
