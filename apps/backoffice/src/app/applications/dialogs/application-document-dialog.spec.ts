import { Component, input, signal, type Type } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { AdminDoctorApplicationsApi } from '@supadoc/data-access';
import type { ApplicationDocumentDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import type { ViewerSource } from '@supadoc/viewer';
import { firstValueFrom, NEVER, type Observable, of } from 'rxjs';
import { EMBEDDED_VIEWER } from '../../shared/viewer-sources';
import { applicationDocument } from '../testing';
import { ApplicationDocumentDialog } from './application-document-dialog';

@Component({ selector: 'bo-stub-viewer', template: '' })
class StubViewer {
  /** The bodies created so far (the dialog creates them with a ViewContainerRef). */
  static created: StubViewer[] = [];
  constructor() {
    StubViewer.created.push(this);
  }
  readonly source = input.required<ViewerSource>();
  readonly mode = input('modal');
  readonly tone = input('auto');
}

@Component({
  imports: [ApplicationDocumentDialog],
  template: `<bo-application-document-dialog [open]="open()" applicationId="app-1" [document]="doc()" subtitle="Ada Obi · GVM-DR-2026-48213" (closed)="open.set(false)" />`,
})
class Host {
  readonly open = signal(false);
  readonly doc = signal<ApplicationDocumentDto | null>(applicationDocument());
}

describe('ApplicationDocumentDialog', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;
  let documentFile: ReturnType<typeof vi.fn>;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const stub = (): StubViewer | undefined => StubViewer.created.at(-1);

  async function setup(file: () => Observable<Blob>, viewer?: () => Promise<Type<unknown>>) {
    documentFile = vi.fn(file);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideSupadocIcons(),
        { provide: AdminDoctorApplicationsApi, useValue: { documentFile } },
        ...(viewer ? [{ provide: EMBEDDED_VIEWER, useValue: viewer }] : []),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
  }

  afterEach(() => el?.remove());

  it('embeds the viewer (staff_verification) beside the unchanged details, in a scrolling xl dialog', async () => {
    await setup(() => of(new Blob(['%PDF'], { type: 'application/pdf' })), () => Promise.resolve(StubViewer));
    host.open.set(true);
    await render();

    const dialog = el.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.className).toContain('sd-dialog--xl');
    // The standard layout keeps its scrolling body, so the details stay reachable.
    expect(dialog.querySelector('.overflow-y-auto bo-embedded-viewer')).not.toBeNull();
    const body = el.querySelector('bo-stub-viewer') as HTMLElement;
    expect(body.className).toContain('h-[min(70dvh,48rem)]');
    expect(body.className).not.toMatch(/lg:h-/);
    expect(stub()?.mode()).toBe('embedded');
    expect(stub()?.source()).toMatchObject({ key: 'appdoc:doc-1', policy: 'staff_verification', title: 'Current MDCN practising licence' });

    const text = el.textContent?.replace(/\s+/g, ' ') ?? '';
    for (const part of ['Document', 'File', 'apl.pdf', 'Size', '117 KB', 'Uploaded', 'State', 'Current', 'With application']) expect(text).toContain(part);
    expect(text).toContain('Confidential. Opening a document is recorded in the audit log.');
    expect(text).not.toContain('Open in new tab');
    expect(el.querySelector('[data-autofocus]')?.textContent?.trim()).toBe('Close');
  });

  it('keys the source on the document id only: a refreshed copy is not fetched again', async () => {
    await setup(() => of(new Blob(['%PDF'], { type: 'application/pdf' })), () => Promise.resolve(StubViewer));
    host.open.set(true);
    await render();
    const first = stub()?.source();
    host.doc.set(applicationDocument({ state: 'replaced' }));
    await render();
    expect(stub()?.source()).toBe(first);
    expect(el.textContent).toContain('Replaced by a newer upload');

    host.doc.set(applicationDocument({ id: 'doc-2', slot: 'government_id', slot_label: 'Government-issued ID' }));
    await render();
    expect(stub()?.source()).not.toBe(first);
    expect(stub()?.source().key).toBe('appdoc:doc-2');
    expect(documentFile).not.toHaveBeenCalled();
  });

  it('types the file from the stored mime, even when the response says another viewable type', async () => {
    await setup(() => of(new Blob(['%PDF'], { type: 'image/png' })), () => Promise.resolve(StubViewer));
    host.open.set(true);
    await render();
    const file = await firstValueFrom((stub() as StubViewer).source().load());
    expect(documentFile).toHaveBeenCalledWith('app-1', 'doc-1');
    expect(file.mime).toBe('application/pdf');
  });

  it('closing removes the viewer (the file is released)', async () => {
    await setup(() => of(new Blob()), () => Promise.resolve(StubViewer));
    host.open.set(true);
    await render();
    expect(el.querySelector('bo-stub-viewer')).not.toBeNull();
    host.open.set(false);
    await render();
    expect(el.querySelector('bo-stub-viewer')).toBeNull();
  });

  it('the real viewer offers Download and Print, and no "Open in new tab"', async () => {
    await setup(() => NEVER);
    host.open.set(true);
    await render();
    // The body's chunk arrives asynchronously: run change detection until it is there.
    await vi.waitFor(
      () => {
        fixture.detectChanges();
        expect(el.querySelector('sd-document-viewer')).not.toBeNull();
      },
      { timeout: 4000 },
    );
    await render();
    const viewer = el.querySelector('sd-document-viewer') as HTMLElement;
    expect(viewer.className).toContain('h-[min(70dvh,48rem)]');
    expect(viewer.querySelector('[aria-label="Download Current MDCN practising licence"]')).not.toBeNull();
    expect(viewer.querySelector('[aria-label="Print"]')).not.toBeNull();
    expect(el.querySelector('[href^="blob:"], a[target="_blank"]')).toBeNull();
    expect(el.textContent).not.toContain('Open in new tab');
    expect(documentFile).toHaveBeenCalledTimes(1);
  });
});
