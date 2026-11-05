import { Component, input, signal, type Type } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { SpecialistsApi } from '@supadoc/data-access';
import type { SpecialistCredentialDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import type { ViewerSource } from '@supadoc/viewer';
import { firstValueFrom, NEVER, type Observable, of } from 'rxjs';
import { EMBEDDED_VIEWER } from '../../shared/viewer-sources';
import { CredentialDialog, type CredentialDialogMode } from './credential-dialog';

function credential(over: Partial<SpecialistCredentialDto> = {}): SpecialistCredentialDto {
  return {
    id: 'cred-1',
    type: 'annual_practising_licence',
    type_label: 'Annual practising licence',
    number: 'APL/2026/001',
    issued_at: '2026-01-01',
    expires_at: '2099-12-31',
    status: 'pending',
    status_label: 'Pending',
    rejection_reason: null,
    original_name: 'licence.pdf',
    mime: 'application/pdf',
    size_bytes: 2048,
    reviewed_at: null,
    created_at: '2026-10-20T10:00:00+00:00',
    ...over,
  };
}

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
  imports: [CredentialDialog],
  template: `<bo-credential-dialog [open]="open()" specialistId="sp-1" doctorName="Dr Ada Obi" [credential]="c()" [mode]="mode()" (closed)="open.set(false)" />`,
})
class Host {
  readonly open = signal(false);
  readonly c = signal<SpecialistCredentialDto | null>(credential());
  readonly mode = signal<CredentialDialogMode>('view');
}

describe('CredentialDialog', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;
  let credentialFile: ReturnType<typeof vi.fn>;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const stub = (): StubViewer | undefined => StubViewer.created.at(-1);
  const text = () => el.textContent?.replace(/\s+/g, ' ') ?? '';

  async function setup(file: () => Observable<Blob>, viewer?: () => Promise<Type<unknown>>) {
    credentialFile = vi.fn(file);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideSupadocIcons(),
        { provide: SpecialistsApi, useValue: { credentialFile, verifyCredential: vi.fn(), rejectCredential: vi.fn() } },
        ...(viewer ? [{ provide: EMBEDDED_VIEWER, useValue: viewer }] : []),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
  }

  async function openAs(mode: CredentialDialogMode) {
    host.mode.set(mode);
    host.open.set(true);
    await render();
  }

  afterEach(() => el?.remove());

  it('embeds the viewer (staff_verification) in a scrolling xl dialog, with the details unchanged', async () => {
    await setup(() => of(new Blob()), () => Promise.resolve(StubViewer));
    await openAs('view');
    const dialog = el.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.className).toContain('sd-dialog--xl');
    expect(dialog.querySelector('.overflow-y-auto bo-embedded-viewer')).not.toBeNull();
    const body = el.querySelector('bo-stub-viewer') as HTMLElement;
    expect(body.className).toContain('h-[min(70dvh,48rem)]');
    expect(body.className).not.toMatch(/lg:h-/);
    expect(stub()?.mode()).toBe('embedded');
    expect(stub()?.source()).toMatchObject({ key: 'cred:cred-1', policy: 'staff_verification', title: 'Annual practising licence', meta: ['licence.pdf'] });
    for (const part of ['Number', 'APL/2026/001', 'Issued', 'Expires', 'Uploaded', 'Waiting for review']) expect(text()).toContain(part);
    expect(text()).toContain('Confidential. Opening a document is recorded in the audit log.');
    expect(text()).not.toContain('Open in new tab');
  });

  it('keys the source on the credential id only and types the file from the stored mime', async () => {
    await setup(() => of(new Blob(['x'], { type: 'application/pdf' })), () => Promise.resolve(StubViewer));
    host.c.set(credential({ mime: 'image/png', original_name: 'licence.png' }));
    await openAs('view');
    const first = stub()?.source();
    host.c.set(credential({ mime: 'image/png', original_name: 'licence.png', status: 'verified', reviewed_at: '2026-10-21T10:00:00+00:00' }));
    await render();
    expect(stub()?.source()).toBe(first);
    const file = await firstValueFrom((first as ViewerSource).load());
    expect(credentialFile).toHaveBeenCalledWith('sp-1', 'cred-1');
    expect(credentialFile).toHaveBeenCalledTimes(1);
    expect(file.mime).toBe('image/png');
  });

  it('verify mode: focus starts on the form, and the submit stays reachable below the viewer', async () => {
    await setup(() => of(new Blob()), () => Promise.resolve(StubViewer));
    await openAs('verify');
    const auto = el.querySelector('[data-autofocus]') as HTMLInputElement;
    expect(auto.type).toBe('checkbox');
    expect(auto.closest('form')?.id).toBe('bo-cred-verify');
    // The form and the footer button are in the dialog, after the viewer in DOM order.
    const viewer = el.querySelector('bo-embedded-viewer') as HTMLElement;
    const form = el.querySelector('#bo-cred-verify') as HTMLElement;
    expect(viewer.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const submit = el.querySelector('button[type="submit"][form="bo-cred-verify"]') as HTMLButtonElement;
    expect(submit.textContent).toContain('Verify document');
    expect(submit.disabled).toBe(false);
  });

  it('reject mode: the reason field and its submit are there', async () => {
    await setup(() => of(new Blob()), () => Promise.resolve(StubViewer));
    await openAs('reject');
    expect((el.querySelector('[data-autofocus]') as HTMLElement).tagName).toBe('TEXTAREA');
    expect(el.querySelector('button[type="submit"][form="bo-cred-reject"]')?.textContent).toContain('Reject document');
  });

  it('the real viewer offers Download, and no "Open in new tab"', async () => {
    await setup(() => NEVER);
    await openAs('view');
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
    expect(viewer.querySelector('[aria-label="Download Annual practising licence"]')).not.toBeNull();
    expect(el.querySelector('[href^="blob:"], a[target="_blank"]')).toBeNull();
    expect(el.textContent).not.toContain('Open in new tab');
  });
});
