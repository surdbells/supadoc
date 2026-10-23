import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '@supadoc/ui';
import { type Observable, of, Subject, throwError } from 'rxjs';
import { DocumentViewer, documentKind } from './document-viewer';

@Component({
  imports: [DocumentViewer],
  template: `@if (show()) { <bo-document-viewer [load]="load()" [mime]="mime()" name="licence.pdf" [sizeBytes]="2048" goneMessage="Gone for good." /> }`,
})
class Host {
  readonly show = signal(true);
  readonly mime = signal('application/pdf');
  readonly load = signal<(() => Observable<Blob>) | null>(null);
}

describe('DocumentViewer', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;
  let created: Blob[];
  let revoked: string[];

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    created = [];
    revoked = [];
    let n = 0;
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return `blob:test/${++n}`;
    }) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u));
    await TestBed.configureTestingModule({ imports: [Host], providers: [provideSupadocIcons()] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
  });

  it('types the file from the stored mime, never the response', () => {
    expect(documentKind('application/pdf')).toBe('pdf');
    expect(documentKind('image/png')).toBe('image');
    expect(documentKind('IMAGE/JPEG')).toBe('image');
    expect(documentKind('text/html')).toBe('other');
    expect(documentKind(null)).toBe('other');
  });

  it('puts a PDF on the native frame from a blob URL, and revokes it when the viewer goes', async () => {
    host.load.set(() => of(new Blob(['%PDF-1.7'], { type: 'text/html' })));
    await render();
    const frame = el.querySelector('iframe');
    expect(frame?.getAttribute('title')).toBe('Document: licence.pdf');
    expect(frame?.src).toBe('blob:test/1');
    expect(created[0].type).toBe('application/pdf');
    expect(el.textContent).toContain('licence.pdf · 2 KB');
    expect(el.querySelector('a[download="licence.pdf"]')?.getAttribute('href')).toBe('blob:test/1');
    host.show.set(false);
    await render();
    expect(revoked).toEqual(['blob:test/1']);
  });

  it('shows an image on a native img; anything else is download only', async () => {
    host.mime.set('image/png');
    host.load.set(() => of(new Blob(['png'])));
    await render();
    expect(el.querySelector('img')?.src).toBe('blob:test/1');
    expect(el.querySelector('img')?.getAttribute('alt')).toBe('licence.pdf');

    host.mime.set('application/zip');
    host.load.set(() => of(new Blob(['zip'])));
    await render();
    expect(el.querySelector('img')).toBeNull();
    expect(created[1].type).toBe('application/octet-stream');
    expect(el.textContent).toContain("This file type can't be shown here.");
    expect(revoked).toEqual(['blob:test/1']);
  });

  it('says so when the stored file is gone (no retry), and offers a retry otherwise', async () => {
    host.load.set(() => throwError(() => ({ statusCode: 404 })));
    await render();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Gone for good.');
    expect(el.textContent).not.toContain('Try again');

    let calls = 0;
    const reads = [new Subject<Blob>(), new Subject<Blob>()];
    host.load.set(() => reads[calls++]);
    await render();
    expect(el.textContent).toContain('Opening the document…');
    reads[0].error({ statusCode: 500 });
    await render();
    const retry = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Try again'));
    expect(retry).toBeTruthy();
    retry?.click();
    await render();
    expect(calls).toBe(2);
    reads[1].next(new Blob(['%PDF']));
    await render();
    expect(el.querySelector('iframe')).toBeTruthy();
  });
});
