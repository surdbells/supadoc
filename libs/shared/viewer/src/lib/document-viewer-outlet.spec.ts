import { Component, signal, TemplateRef, viewChild } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { DialogService, provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { DocumentViewerOutletComponent } from './document-viewer-outlet';
import { DocumentViewerService, VIEWER_CHUNKS } from './document-viewer.service';
import { PDF_LOADER, type PdfLoader } from './pdf-loader';
import { TEXT_LAYER_RENDERER } from './text-layer';
import * as copy from './viewer-copy';
import { blobSource, viewOnlySource } from './viewer-sources';
import type { ViewerCallContext, ViewerSource } from './viewer-types';

const noop = (): void => undefined;

@Component({
  template: `
    <ng-template #bar>
      <button type="button" class="band-back">Back to call</button><span class="band-status" role="status">Recording</span>
      @if (live()) {
        <span class="band-controls"><button type="button" class="band-mute">Mute</button><button type="button" class="band-end" aria-label="End call"></button></span>
      }
    </ng-template>
    <ng-template #peer><div role="img" aria-label="Ada Obi, live video" class="fake-tile"></div></ng-template>
  `,
})
class CallHostComponent {
  readonly bar = viewChild.required('bar', { read: TemplateRef });
  readonly peer = viewChild.required('peer', { read: TemplateRef });
  /** Mute and End render only in a live call (as in both call pages). */
  readonly live = signal(true);
}

let pages = 1;
const loader: PdfLoader = async () => ({
  promise: Promise.resolve({
    numPages: pages,
    getPage: async () => ({
      getViewport: ({ scale, rotation = 0 }: { scale: number; rotation?: number }) => ({ width: 600 * scale, height: 800 * scale, scale, rotation }),
      render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
      cleanup: () => undefined,
      streamTextContent: () => ({}),
    }),
  }),
  destroy: () => Promise.resolve(),
});

const pdf = () => new Blob(['%PDF'], { type: 'application/pdf' });
function owner(key: string, over: Partial<ViewerSource> = {}): ViewerSource {
  return blobSource({ key, title: `Doc ${key}`, typeLabel: 'Report', extension: 'pdf', policy: 'owner', ...(over as object), fetch: () => of(pdf()) } as Parameters<typeof blobSource>[0]);
}
const viewOnly = () =>
  viewOnlySource({
    key: 'doc:1',
    title: 'Lab report',
    typeLabel: 'Laboratory test report',
    extension: 'pdf',
    sizeLabel: '1.2 MB',
    meta: ['Added 3 Nov 2026', 'Patient upload'],
    view: () => of({ blob: pdf(), mime: 'application/pdf', viewRef: 'VM-7F3A2C1D', viewedAt: '2026-11-04T20:05:09Z' }),
    recordPrint: () => of(null),
    notSharedText: 'x',
  });
const WM = { viewerName: 'Dr Ada Obi', timeZone: 'America/Chicago' };

describe('DocumentViewerOutletComponent (sd-document-viewer-outlet)', () => {
  let fixture: ComponentFixture<DocumentViewerOutletComponent>;
  let el: HTMLElement;
  let svc: DocumentViewerService;
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  const realGetContext = proto['getContext'];

  const settle = async (rounds = 8) => {
    for (let i = 0; i < rounds; i++) {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };
  const text = () => (el.textContent ?? '').replace(/\s+/g, ' ');
  const dialog = () => el.querySelector('dialog') as HTMLDialogElement;

  /** The call page of the last callContext() (its band template). */
  let host: CallHostComponent;

  function callContext(over: Partial<ViewerCallContext> = {}) {
    const f = TestBed.createComponent(CallHostComponent);
    f.detectChanges();
    host = f.componentInstance;
    // A new fixture removes every earlier root element (the outlet's host is one): put it back,
    // so focus can land in it.
    if (el && !el.isConnected) document.body.appendChild(el);
    const ctx: ViewerCallContext = {
      bar: f.componentInstance.bar(),
      peer: f.componentInstance.peer(),
      peerName: signal('Ada Obi'),
      tone: signal<'dark' | 'light'>('dark'),
      live: signal(true),
      sharingScreen: signal(false),
      recording: signal(false),
      stopSharing: vi.fn(),
      willOpen: vi.fn(),
      didClose: vi.fn(),
      ...over,
    };
    return ctx;
  }

  type BodyChunk = () => Promise<{ DocumentViewerComponent: unknown }>;
  const realBody: BodyChunk = () => import('./document-viewer');
  async function setup(body: BodyChunk = realBody) {
    TestBed.configureTestingModule({
      imports: [DocumentViewerOutletComponent],
      providers: [
        provideSupadocIcons(),
        // The service must not mount its own outlet here: this spec renders one directly.
        { provide: VIEWER_CHUNKS, useValue: { outlet: () => new Promise(() => undefined), body } },
        { provide: PDF_LOADER, useValue: loader },
        { provide: TEXT_LAYER_RENDERER, useValue: () => ({ promise: Promise.resolve(), cancel: () => undefined }) },
        { provide: DialogService, useValue: { confirm: vi.fn(async () => ({ confirmed: true })), requests: () => [] } },
      ],
    });
    svc = TestBed.inject(DocumentViewerService);
    fixture = TestBed.createComponent(DocumentViewerOutletComponent);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await settle();
  }

  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });
  afterAll(() => {
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  });
  beforeEach(() => {
    pages = 1;
    proto['getContext'] = () => ({ save: noop, restore: noop, translate: noop, rotate: noop, fillText: noop, strokeText: noop, drawImage: noop, fillRect: noop, measureText: () => ({ width: 10 }) });
  });
  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    proto['getContext'] = realGetContext;
    document.documentElement.removeAttribute('data-theme');
    vi.restoreAllMocks();
  });

  it('with no session nothing inside the @if exists (the body is never created without a source)', async () => {
    await setup();
    expect(dialog()).toBeNull();
    expect(el.querySelector('sd-document-viewer')).toBeNull();
    expect(el.querySelector('.sdv-wait')).toBeNull();
  });

  it('is an sd-dialog size="viewer" labelled by the title and described by the meta line', async () => {
    await setup();
    svc.open(viewOnly(), { watermark: WM });
    await settle();
    const d = dialog();
    expect(d.classList.contains('sd-dialog--viewer')).toBe(true);
    const title = el.querySelector(`#${d.getAttribute('aria-labelledby')}`);
    expect(title?.tagName).toBe('H2');
    expect(title?.id).toMatch(/^sd-viewer-title-\d+$/);
    expect(title?.textContent?.trim()).toBe('Lab report');
    expect(title?.getAttribute('tabindex')).toBe('-1');
    expect(title?.hasAttribute('data-autofocus')).toBe(true);
    const meta = el.querySelector(`#${d.getAttribute('aria-describedby')}`);
    expect(meta?.id).toMatch(/^sd-viewer-meta-\d+$/);
    expect(meta?.textContent?.trim()).toBe('Laboratory test report · PDF · 1.2 MB · Added 3 Nov 2026 · Patient upload');
    expect(el.querySelector('sd-document-viewer')).not.toBeNull();
    expect(el.querySelector('.sd-viewer-frame sd-document-viewer')).not.toBeNull();
    // The body fills the content area (a flex item that grows), whatever the content's height.
    const body = el.querySelector('sd-document-viewer') as HTMLElement;
    expect(body.parentElement?.classList.contains('sdv-content')).toBe(true);
    expect(body.classList.contains('sdv-modal')).toBe(true);
    const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');
    expect(css).toMatch(/sd-document-viewer\.sdv-modal\s*\{\s*flex:\s*1 1 0%/);
  });

  it("the browser's own print prints none of the viewer: the outlet (header, band, PiP) and its dialog are hidden", async () => {
    await setup();
    svc.open(owner('a'));
    await settle();
    const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');
    expect(css).toMatch(/@media print\s*\{\s*sd-document-viewer-outlet\s*,\s*sd-document-viewer-outlet dialog\s*\{\s*display:\s*none\s*!important/);
  });

  it('shows the policy notice: view_only and staff, none for owner', async () => {
    await setup();
    svc.open(viewOnly(), { watermark: WM });
    await settle(3);
    expect(el.querySelector('.sdv-notice')?.textContent?.trim()).toBe('View only · Downloads are turned off for patient documents.');
    svc.open(owner('s', { policy: 'staff_record' }));
    await settle(3);
    expect(el.querySelector('.sdv-notice')?.textContent?.trim()).toBe('Confidential. Opening a document is recorded in the audit log.');
    svc.open(owner('o'));
    await settle(3);
    expect(el.querySelector('.sdv-notice')).toBeNull();
  });

  it('document navigation: named buttons, the counter, the list label; at the end focus moves to the title; settled moves are announced', async () => {
    await setup();
    svc.open([owner('a'), owner('b'), owner('c')], { index: 1, listLabel: 'shared documents' });
    await settle();
    const prev = el.querySelector<HTMLButtonElement>('button[aria-label^="Previous document"]') as HTMLButtonElement;
    const next = el.querySelector<HTMLButtonElement>('button[aria-label^="Next document"]') as HTMLButtonElement;
    expect(prev.getAttribute('aria-label')).toBe('Previous document: Doc a');
    expect(next.getAttribute('aria-label')).toBe('Next document: Doc c');
    expect(text()).toContain('Document 2 of 3');
    expect(text()).toContain('Document 2 of 3 in shared documents');
    next.focus();
    next.click();
    await settle();
    expect(svc.index()).toBe(2);
    expect(next.disabled).toBe(true);
    expect(document.activeElement?.tagName).toBe('H2');
    await new Promise((r) => setTimeout(r, 450));
    fixture.detectChanges();
    expect(text()).toContain('Document 3 of 3: Doc c');
  });

  it('the call band renders only while a call is registered, inside .sd-call[data-theme="dark"], and the tone follows the cockpit', async () => {
    await setup();
    svc.open(owner('a'));
    await settle();
    expect(el.querySelector('.band-back')).toBeNull();
    expect((el.querySelector('.sd-viewer-frame') as HTMLElement).style.getPropertyValue('--sd-viewer-chrome')).toBe('#ffffff');
    svc.close();
    await settle();
    svc.registerCall(callContext());
    svc.open(owner('a'));
    await settle();
    const band = el.querySelector('.band-back')?.closest('.sd-call');
    expect(band?.getAttribute('data-theme')).toBe('dark');
    expect((el.querySelector('.sd-viewer-frame') as HTMLElement).style.getPropertyValue('--sd-viewer-chrome')).toBe('#1c2b3a');
  });

  it("the patient's auto tone follows html[data-theme]", async () => {
    await setup();
    document.documentElement.setAttribute('data-theme', 'dark');
    svc.open(owner('a'), { tone: 'auto' });
    await settle();
    expect((el.querySelector('.sd-viewer-frame') as HTMLElement).style.getPropertyValue('--sd-viewer-chrome')).toBe('#161f2b');
    expect((el.querySelector('.sd-viewer-frame') as HTMLElement).style.getPropertyValue('--sd-viewer-page')).toBe('#ffffff');
  });

  it('screen sharing: details hidden; view_only is covered, other policies get the banner; Stop sharing calls the context', async () => {
    await setup();
    const sharing = signal(true);
    const ctx = callContext({ sharingScreen: sharing });
    svc.registerCall(ctx);
    svc.open([viewOnly(), owner('b')], { watermark: WM, listLabel: 'shared documents' });
    await settle();
    expect(el.querySelector('[id^="sd-viewer-meta-"]')?.textContent?.trim()).toBe('Details hidden while you share your screen.');
    expect(text()).not.toContain('in shared documents');
    expect(el.querySelector('.sdv-cover')).not.toBeNull();
    expect(el.querySelector('.sdv-banner')).toBeNull();
    svc.go(1);
    await settle();
    await new Promise((r) => setTimeout(r, 450));
    await settle();
    expect(el.querySelector('.sdv-cover')).toBeNull();
    expect(el.querySelector('.sdv-banner')?.textContent).toContain(copy.shareBanner(false));
    (el.querySelector('.sdv-banner button') as HTMLButtonElement).click();
    expect(ctx.stopSharing).toHaveBeenCalledTimes(1);
    sharing.set(false);
    await settle();
    expect(el.querySelector('.sdv-banner')).toBeNull();
    expect(el.querySelector('[id^="sd-viewer-meta-"]')?.textContent?.trim()).toBe('Report · PDF');
  });

  it('the PiP layer: the peer as a sibling of the body, placed from stageInsets; buttons outside role=img; Move cycles; Hide shows "Show video"', async () => {
    await setup();
    svc.registerCall(callContext());
    svc.open(owner('a'));
    await settle();
    const layer = el.querySelector('.sdv-pip-layer') as HTMLElement;
    expect(layer).not.toBeNull();
    expect(layer.classList.contains('sd-call')).toBe(true);
    expect(layer.getAttribute('data-theme')).toBe('dark');
    expect(layer.closest('sd-document-viewer')).toBeNull();
    expect(layer.closest('.sdv-stage')).toBeNull();
    expect(layer.parentElement?.classList.contains('sdv-content')).toBe(true);
    const img = layer.querySelector('[role="img"]') as HTMLElement;
    expect(img.getAttribute('aria-label')).toBe('Ada Obi, live video');
    const buttons = Array.from(layer.querySelectorAll('button'));
    expect(buttons.length).toBe(2);
    expect(buttons.every((b) => !img.contains(b))).toBe(true);
    (fixture.componentInstance as unknown as { insets: { set(v: unknown): void } }).insets.set({ top: 52, right: 0, bottom: 0, left: 176 });
    fixture.detectChanges();
    expect(layer.style.top).toBe('52px');
    expect(layer.style.left).toBe('176px');
    const pip = layer.querySelector('.sdv-pip') as HTMLElement;
    expect(pip.classList.contains('sdv-pip--br')).toBe(true);
    const move = buttons.find((b) => b.getAttribute('aria-label') === "Move Ada Obi's video to another corner") as HTMLButtonElement;
    move.click();
    await settle(2);
    expect(pip.classList.contains('sdv-pip--bl')).toBe(true);
    expect(text()).toContain('Video moved to the bottom left.');
    for (let i = 0; i < 3; i++) move.click();
    fixture.detectChanges();
    expect(pip.classList.contains('sdv-pip--br')).toBe(true);
    const hide = buttons.find((b) => b.getAttribute('aria-label') === 'Hide video') as HTMLButtonElement;
    hide.focus();
    hide.click();
    await settle(2);
    expect(pip.classList.contains('sdv-pip--hidden')).toBe(true);
    // Still rendered (the track keeps playing), so no hand-over churn.
    expect(layer.querySelector('.fake-tile')).not.toBeNull();
    const show = Array.from(el.querySelectorAll<HTMLButtonElement>('.sdv-band button')).find((b) => b.textContent?.includes('Show video'));
    expect(show).toBeTruthy();
    // Focus follows the control: Hide video → Show video → the tile's first button (never the title).
    expect(document.activeElement).toBe(show);
    show?.click();
    await settle(2);
    expect(pip.classList.contains('sdv-pip--hidden')).toBe(false);
    expect(document.activeElement).toBe(move);
  });

  it('band order (§3.3): "Show video" opens the band\'s control group, before the host\'s Mute and End', async () => {
    await setup();
    svc.registerCall(callContext());
    svc.open(owner('a'));
    await settle();
    (el.querySelector('button[aria-label="Hide video"]') as HTMLButtonElement).click();
    await settle(2);
    const group = el.querySelector('.sdv-band > .sdv-band-controls') as HTMLElement;
    const show = group.querySelector('button') as HTMLButtonElement;
    expect(show.textContent).toContain('Show video');
    expect(group.firstElementChild).toBe(show);
    // Nothing of the outlet's follows the host's content (End stays last).
    expect(el.querySelector('.sdv-band')?.lastElementChild).toBe(group);
    const order = Array.from(el.querySelectorAll<HTMLButtonElement>('.sdv-band button')).map((b) => b.textContent?.trim() || b.getAttribute('aria-label'));
    expect(order).toEqual(['Show video', 'Back to call', 'Mute', 'End call']);
  });

  it('a focused band control that disappears (Mute when the call ends) sends focus to the title; focus elsewhere stays put (§1.10.2)', async () => {
    await setup();
    svc.registerCall(callContext());
    svc.open(owner('a'));
    await settle();
    const title = el.querySelector<HTMLElement>('[id^="sd-viewer-title-"]') as HTMLElement;
    (el.querySelector('.band-mute') as HTMLButtonElement).focus();
    host.live.set(false);
    await settle(2);
    expect(el.querySelector('.band-mute')).toBeNull();
    expect(document.activeElement).toBe(title);

    // Focus moved on before the control went: it stays where it is.
    host.live.set(true);
    await settle(2);
    (el.querySelector('.band-mute') as HTMLButtonElement).focus();
    const close = el.querySelector<HTMLButtonElement>('button[aria-label="Close document"]') as HTMLButtonElement;
    close.focus();
    host.live.set(false);
    await settle(2);
    expect(document.activeElement).toBe(close);

    // A browser that also fires focusout (no relatedTarget) as the control goes: still the title.
    host.live.set(true);
    await settle(2);
    const mute = el.querySelector('.band-mute') as HTMLButtonElement;
    mute.focus();
    host.live.set(false);
    mute.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await settle(2);
    expect(document.activeElement).toBe(title);
  });

  it('a removed band control does not take focus while the viewer closes, or once focus left it for the window', async () => {
    await setup();
    svc.registerCall(callContext());
    svc.open(owner('a'));
    await settle();
    const mute = el.querySelector('.band-mute') as HTMLButtonElement;
    mute.focus();
    // The window lost focus: focusout with no relatedTarget, but Mute is still the active element.
    mute.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await settle(2);
    expect(document.activeElement).toBe(mute);
    // The call ends and the viewer closes in the same turn: the service owns focus then.
    const title = el.querySelector<HTMLElement>('[id^="sd-viewer-title-"]') as HTMLElement;
    const focusTitle = vi.spyOn(title, 'focus');
    host.live.set(false);
    svc.close();
    await settle(2);
    expect(el.querySelector('.band-mute')).toBeNull();
    expect(focusTitle).not.toHaveBeenCalled();
  });

  it('while the body chunk loads, the skeleton shows with the PiP, then the body', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await setup(() => gate.then(() => realBody()));
    svc.registerCall(callContext());
    svc.open(owner('a'));
    await settle();
    expect(el.querySelector('.sdv-wait')?.textContent).toContain('Opening document…');
    expect(el.querySelector('sd-document-viewer')).toBeNull();
    expect(el.querySelector('.sdv-pip-layer .fake-tile')).not.toBeNull();
    release();
    await settle();
    expect(el.querySelector('.sdv-wait')).toBeNull();
    expect(el.querySelector('sd-document-viewer')).not.toBeNull();
    expect(el.querySelector('.sdv-pip-layer .fake-tile')).not.toBeNull();
  });

  it('when the body chunk fails (e.g. old hashes after a deploy): the PiP stays; no Reload during a live call', async () => {
    await setup(() => Promise.reject(new Error('chunk 404')));
    const live = signal(true);
    svc.registerCall(callContext({ live }));
    svc.open(owner('a'));
    await settle();
    expect(el.querySelector('.sdv-wait [role="alert"]')?.textContent).toBe(copy.UPDATE_IN_CALL);
    expect(el.querySelector('.sdv-wait button')).toBeNull();
    expect(el.querySelector('.sdv-pip-layer .fake-tile')).not.toBeNull();
    live.set(false);
    fixture.detectChanges();
    expect(el.querySelector('.sdv-wait [role="alert"]')?.textContent).toBe(copy.CHUNK_RELOAD);
    expect(el.querySelector('.sdv-wait button')?.textContent?.trim()).toBe('Reload');
  });

  it('reopening the same document restores its page and says so', async () => {
    pages = 3;
    await setup();
    svc.saveResume('a', { page: 2, zoomMode: 'custom', zoom: 1.5, rotation: 0 });
    svc.open(owner('a'));
    await settle();
    expect(text()).toContain('Back on page 2.');
    expect(text()).toContain('150%');
  });

  it('a phone held sideways: one row; meta and notice behind Details; the view-only lock stays visible', async () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('orientation: landscape'), media: q, addEventListener: noop, removeEventListener: noop })) as unknown as typeof window.matchMedia;
    try {
      await setup();
      svc.open(viewOnly(), { watermark: WM });
      await settle();
      expect(el.querySelector('.sd-viewer-frame')?.getAttribute('data-layout')).toBe('compact');
      expect(el.querySelector('[id^="sd-viewer-meta-"]')?.classList.contains('sr-only')).toBe(true);
      expect(el.querySelector('.sdv-notice')).toBeNull();
      const lock = el.querySelector('header [role="img"]');
      expect(lock?.getAttribute('aria-label')).toBe('View only · Downloads are turned off for patient documents.');
      const details = el.querySelector<HTMLButtonElement>('button[aria-label="Details"]') as HTMLButtonElement;
      expect(details.getAttribute('aria-expanded')).toBe('false');
      details.click();
      await settle(2);
      const pop = el.querySelector('.sdv-details') as HTMLElement;
      expect(pop.getAttribute('role')).toBe('dialog');
      expect(pop.textContent).toContain('Laboratory test report · PDF · 1.2 MB');
      expect(pop.textContent).toContain('View only');
      expect(el.querySelector('[role="toolbar"]')?.classList.contains('sdv-bar--side')).toBe(true);
      // Esc closes the popover (focus back on Details), not the viewer; the next Esc closes the viewer.
      const esc = (target: Element) => {
        const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        target.dispatchEvent(e);
        return e;
      };
      details.focus();
      expect(esc(details).defaultPrevented).toBe(true);
      await settle(2);
      expect(svc.isOpen()).toBe(true);
      expect(el.querySelector('.sdv-details')).toBeNull();
      expect(details.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(details);
      // From the stage too (the body has nothing open to close).
      details.click();
      await settle(2);
      esc(el.querySelector('.sdv-stage') as HTMLElement);
      await settle(2);
      expect(svc.isOpen()).toBe(true);
      expect(el.querySelector('.sdv-details')).toBeNull();
      esc(details);
      expect(svc.isOpen()).toBe(false);
    } finally {
      window.matchMedia = mm;
    }
  });

  it('a portrait phone: the notice is its own full-width row under the header row; the document counter is for screen readers only (§1.3.3)', async () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: noop, removeEventListener: noop })) as unknown as typeof window.matchMedia;
    try {
      await setup();
      svc.open([viewOnly(), viewOnly()], { watermark: WM });
      await settle();
      expect(el.querySelector('.sd-viewer-frame')?.getAttribute('data-layout')).toBe('phone');
      const header = el.querySelector('header.sdv-head') as HTMLElement;
      const notices = el.querySelectorAll('.sdv-notice');
      expect(notices.length).toBe(1);
      const notice = notices[0] as HTMLElement;
      // A direct child of the header, after Close (it wraps onto its own row), not in the title column.
      expect(notice.parentElement).toBe(header);
      expect(notice.classList.contains('sdv-notice--row')).toBe(true);
      expect(header.lastElementChild).toBe(notice);
      expect(notice.textContent?.trim()).toBe('View only · Downloads are turned off for patient documents.');
      const counter = Array.from(header.querySelectorAll('span')).find((s) => s.textContent?.replace(/\s+/g, ' ').trim() === 'Document 1 of 2') as HTMLElement;
      expect(counter.classList.contains('sr-only')).toBe(true);
      // The meta line stays visible (one line, truncated).
      expect(el.querySelector('[id^="sd-viewer-meta-"]')?.classList.contains('sr-only')).toBe(false);
      const css = Array.from(document.querySelectorAll('style'))
        .map((s) => s.textContent ?? '')
        .join('\n');
      expect(css).toContain('[data-layout=phone] .sdv-head{min-height:56px;padding-top:8px;padding-bottom:8px;flex-wrap:wrap;gap:4px 8px}');
      expect(css).toContain('.sdv-notice--row{flex-basis:100%;min-width:0}');
    } finally {
      window.matchMedia = mm;
    }
  });

  it('a phone held sideways in a call: Details opens under the 48 px row; band labels and the 112×84 PiP controls fit the row and the tile (§1.3.5)', async () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('orientation: landscape'), media: q, addEventListener: noop, removeEventListener: noop })) as unknown as typeof window.matchMedia;
    try {
      await setup();
      svc.registerCall(callContext());
      svc.open(viewOnly(), { watermark: WM });
      await settle();
      (el.querySelector('button[aria-label="Details"]') as HTMLButtonElement).click();
      await settle(2);
      const pop = el.querySelector('.sdv-details') as HTMLElement;
      expect(pop.classList.contains('absolute')).toBe(true);
      expect(Array.from(pop.classList).some((c) => /^mt-/.test(c))).toBe(false);
      const css = Array.from(document.querySelectorAll('style'))
        .map((s) => s.textContent ?? '')
        .join('\n');
      // Anchored below the header row (top: 100%), never over the title.
      expect(css).toContain('.sdv-details{top:calc(100% + 4px)}');
      // A band button's text label marked data-band-label is screen-reader-only in the row.
      expect(css).toContain('[data-layout=compact] .sdv-band [data-band-label]{position:absolute;width:1px;height:1px;');
      // The PiP's Move / Hide are 28 px, and the initials move to the top-left corner, clear of them.
      expect(css).toContain('[data-layout=compact] .sdv-pill button{width:28px;height:28px}');
      expect(css).toContain('[data-layout=compact] .sdv-pip .sdv-peer-off{align-items:flex-start;justify-content:flex-start;padding:6px}');
      expect(el.querySelector('.sd-viewer-frame')?.getAttribute('data-layout')).toBe('compact');
      expect(el.querySelector('.sdv-band')).not.toBeNull();
      expect(el.querySelector('.sdv-pip .sdv-pill')).not.toBeNull();
    } finally {
      window.matchMedia = mm;
    }
  });

  it('Close and Esc close the viewer', async () => {
    await setup();
    svc.open(owner('a'));
    await settle();
    el.querySelector<HTMLButtonElement>('button[aria-label="Close document"]')?.click();
    expect(svc.isOpen()).toBe(false);
    await settle();
    svc.open(owner('a'));
    await settle();
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(svc.isOpen()).toBe(false);
  });
});
