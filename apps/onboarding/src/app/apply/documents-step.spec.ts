import { HttpEventType } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import type { LicenceRoute } from '@supadoc/models';
import { D, doc, draft, HttpTestingController, ok, settle, testProviders, textOf, tick } from '../../testing/onb-testing';
import { ApplicantSession } from '../core/applicant-session';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { FileFieldComponent } from '../shared/file-field';
import { OnbDocumentsStep } from './documents-step';
import { By } from '@angular/platform-browser';

describe('OnbDocumentsStep', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(ApplicantSession).setDraftToken('tok');
  });

  afterEach(() => http.verify());

  async function create(route: LicenceRoute) {
    TestBed.inject(ApplicationDraftStore).draft.set(
      draft({
        licence_route: route,
        next_step: 'documents',
        sections: { ...draft().sections, licence: route === 'abroad' ? { regulator_name: 'General Medical Council' } : null },
      }),
    );
    const fixture = TestBed.createComponent(OnbDocumentsStep);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle(fixture);
    return { fixture, el };
  }

  it('labels the slots for Nigeria', async () => {
    const { el } = await create('ng');
    const text = textOf(el);
    for (const label of ['Government-issued ID', 'Medical degree certificate', 'Current MDCN practising licence', 'Curriculum vitae']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('Upload the following documents.');
    el.remove();
  });

  it('labels the licence for abroad with the regulator', async () => {
    const { el } = await create('abroad');
    expect(textOf(el)).toContain('Current practising licence');
    expect(textOf(el)).not.toContain('Current MDCN practising licence');
    expect(textOf(el)).toContain('Issued by General Medical Council');
    el.remove();
  });

  it('refuses a wrong file type before uploading', async () => {
    const { fixture, el } = await create('ng');
    const field = fixture.debugElement.queryAll(By.directive(FileFieldComponent))[0].componentInstance as FileFieldComponent;
    field.take(new File(['x'], 'id.txt', { type: 'text/plain' }));
    await settle(fixture);
    expect(textOf(el)).toContain('File must be PDF, PNG or JPG.');
    el.remove();
  });

  it('uploads with progress, then shows the file', async () => {
    const { fixture, el } = await create('ng');
    const field = fixture.debugElement.queryAll(By.directive(FileFieldComponent))[0].componentInstance as FileFieldComponent;
    field.take(new File(['x'], 'id.png', { type: 'image/png' }));
    await settle(fixture);
    const req = http.expectOne(`${D}/documents`);
    expect(req.request.body instanceof FormData).toBe(true);
    expect((req.request.body as FormData).get('slot')).toBe('government_id');
    req.event({ type: HttpEventType.UploadProgress, loaded: 50, total: 100 });
    await settle(fixture);
    expect(el.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    req.flush(ok(doc('government_id', { original_name: 'id.png' })));
    await tick();
    http.expectOne(D).flush(ok(draft({ documents: [doc('government_id', { original_name: 'id.png' })] })));
    await settle(fixture);
    expect(textOf(el)).toContain('id.png');
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
    el.remove();
  });
});
