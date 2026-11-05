import { Injector } from '@angular/core';
import { DocumentViewerService, type ViewerSource } from '@supadoc/viewer';
import { firstValueFrom, of } from 'rxjs';
import { doc } from '../../testing/onb-testing';
import { applicantDocumentSource, openApplicantDocument } from './viewer-sources';

describe('onboarding viewer sources', () => {
  it("builds the applicant's own document: owner (view, print, download), keyed by id", async () => {
    const fetch = vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' })));
    const s = applicantDocumentSource(fetch, doc('mdcn_certificate', { original_name: 'mdcn.pdf', slot_label: 'MDCN full registration certificate', size_bytes: 3072 }));
    expect(s).toMatchObject({
      key: 'appdoc:doc-mdcn_certificate',
      title: 'mdcn.pdf',
      typeLabel: 'MDCN full registration certificate',
      extension: 'pdf',
      sizeLabel: '3 KB',
      policy: 'owner',
      filename: 'mdcn.pdf',
    });
    // Download saves the viewed bytes (no signed link, no tab).
    expect(s.download).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    const file = await firstValueFrom(s.load());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(file.mime).toBe('application/pdf');
  });

  it('names the file kind from the stored type', () => {
    const kind = (mime: 'application/pdf' | 'image/png' | 'image/jpeg') =>
      applicantDocumentSource(() => of(new Blob()), doc('government_id', { mime })).extension;
    expect(kind('image/png')).toBe('png');
    expect(kind('image/jpeg')).toBe('jpg');
    expect(kind('application/pdf')).toBe('pdf');
  });

  it('opens the source in the shared viewer', () => {
    const open = vi.fn(() => ({ closed: Promise.resolve(), close: () => undefined }));
    const injector = Injector.create({ providers: [{ provide: DocumentViewerService, useValue: { open } }] });
    openApplicantDocument(injector, () => of(new Blob()), doc('curriculum_vitae'));
    expect(open).toHaveBeenCalledTimes(1);
    const [source] = open.mock.calls[0] as unknown as [ViewerSource];
    expect(source).toMatchObject({ key: 'appdoc:doc-curriculum_vitae', policy: 'owner' });
  });
});
