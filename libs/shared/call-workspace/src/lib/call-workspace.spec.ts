import { ApplicationRef, Component, computed, output, signal, viewChild } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '@supadoc/ui';
import { CallWorkspace, WorkspacePanel, WS_CSS } from './call-workspace';
import type { WorkspaceFlag, WorkspaceTabDef } from './workspace-types';

/** A call page's tabs and words (the doctor's, as an example: the shell holds none of them). */
type Key = 'notes' | 'prescriptions' | 'labs' | 'followup' | 'copilot' | 'record';
const TABS: readonly WorkspaceTabDef<Key>[] = [
  { key: 'notes', label: 'Consultation Notes', icon: 'square-pen' },
  { key: 'prescriptions', label: 'Prescriptions', icon: 'pill' },
  { key: 'labs', label: 'Lab requests', icon: 'flask-conical' },
  { key: 'followup', label: 'Follow-ups', icon: 'calendar-clock' },
  { key: 'copilot', label: 'Transcript & AI', icon: 'sparkles' },
  { key: 'record', label: 'Full EMR', icon: 'clipboard-list' },
];
const KICKER = 'Consultation tools';
const CLOSE = 'Close consultation tools';
const shareWords = (recording: boolean) => (recording ? 'You are sharing your screen and recording.' : 'You are sharing your screen.');
const UNSAVED: WorkspaceFlag = { mark: 'warn', sr: ', unsaved changes' };
const LIVE: WorkspaceFlag = { mark: 'live', sr: ', transcribing' };
/** WS_CSS's length at 88f505a (5,128) minus the one byte of the print rule's rename (plan X2). */
const WS_CSS_MAX = 5127;

let projectedCreated = 0;

/** A projected component, to tell whether closing destroys it. */
@Component({ selector: 'sd-fake-tool', template: `<input id="fake-field" />` })
class FakeTool {
  readonly stamp = ++projectedCreated;
}

/** A tool's inline form whose Esc dismisses the form only (it prevents the event, as the doctor's RxCancelForm does). */
@Component({
  selector: 'sd-fake-form',
  template: `<form (keydown.escape)="$event.preventDefault(); dismissed.emit()"><input id="fake-form-field" /></form>`,
})
class FakeForm {
  readonly dismissed = output<void>();
}

@Component({
  imports: [CallWorkspace, WorkspacePanel, FakeTool, FakeForm],
  template: `
    <button id="launcher" type="button">Launcher</button>
    <ng-template #bandTpl>
      <button id="band-back" type="button">Back to call</button>
      @if (bandExtra()) {
        <button id="band-mute" type="button">Mute</button>
      }
    </ng-template>
    <ng-template #peerTpl><div id="fake-peer"></div></ng-template>
    <sd-call-workspace
      [open]="open()"
      [(tab)]="tab"
      [tabs]="tabs"
      [band]="bandTpl"
      [peer]="hasPeer() ? peerTpl : null"
      peerName="Bola Ade"
      [title]="title()"
      [kicker]="kicker()"
      [closeLabel]="closeLabel"
      [tablistLabel]="tablistLabel()"
      meta="Female · 34 yrs"
      [allergies]="allergies()"
      [sharing]="sharing()"
      [shareText]="shareText()"
      [shareBanner]="banner() ?? sharing()"
      [flags]="flags()"
      (closed)="onClosed()"
      (stopSharing)="stops = stops + 1"
    >
      <div sdWsPanel="notes" id="notes-panel-host">
        <sd-fake-tool />
        <div data-ws-keep-scroll="transcript" id="kept"></div>
        <button id="in-notes" type="button">In notes</button>
        <div id="target"><p data-ws-focus tabindex="-1" id="target-heading">Target</p></div>
        @if (nested()) {
          <dialog open id="nested-dialog"><button id="in-nested" type="button">Nested</button></dialog>
        }
        @if (stickyBar()) {
          <div id="sticky-bar" class="sticky bottom-0"><button id="in-bar" type="button">Save</button></div>
        }
      </div>
      <div sdWsPanel="labs">
        <sd-fake-form (dismissed)="cancels = cancels + 1" />
      </div>
    </sd-call-workspace>
  `,
})
class Host {
  readonly open = signal(false);
  readonly tab = signal<Key>('notes');
  readonly tabs = TABS;
  readonly title = signal('Bola Ade');
  readonly kicker = signal(KICKER);
  readonly closeLabel = CLOSE;
  readonly tablistLabel = signal('');
  readonly hasPeer = signal(true);
  readonly sharing = signal(false);
  readonly recording = signal(false);
  readonly shareText = computed(() => shareWords(this.recording()));
  /** The share banner on its own (null: it follows sharing, as the doctor binds it). */
  readonly banner = signal<boolean | null>(null);
  readonly bandExtra = signal(false);
  readonly nested = signal(false);
  readonly stickyBar = signal(false);
  readonly allergies = signal<readonly string[]>(['Penicillin']);
  readonly flags = signal<Partial<Record<Key, WorkspaceFlag>>>({});
  readonly tool = viewChild(FakeTool);
  readonly ws = viewChild.required(CallWorkspace);
  closes = 0;
  cancels = 0;
  stops = 0;
  onClosed(): void {
    this.closes++;
    this.open.set(false);
  }
}

/** A page that writes its title statically (title="…"), as sd-dialog's callers do. */
@Component({
  imports: [CallWorkspace],
  template: `<sd-call-workspace [open]="open()" [(tab)]="tab" [tabs]="tabs" title="Dr Ade" kicker="Consultation tools" closeLabel="Close consultation tools" />`,
})
class StaticTitleHost {
  readonly open = signal(false);
  readonly tab = signal<Key>('notes');
  readonly tabs = TABS;
}

describe('CallWorkspace (the shell)', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  const realMatchMedia = window.matchMedia;

  const render = () => {
    fixture.detectChanges();
    TestBed.inject(ApplicationRef).tick();
  };
  /** Timers (focus restores and the like) and renders settle. */
  const settle = async () => {
    render();
    await new Promise((r) => setTimeout(r));
    render();
  };

  function media(matching: string[]) {
    window.matchMedia = ((query: string) => ({
      matches: matching.includes(query),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  }

  function setup() {
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideSupadocIcons()],
    });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    document.body.appendChild(fixture.nativeElement as HTMLElement);
    fixture.detectChanges();
  }

  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const dialog = () => q<HTMLDialogElement>('dialog.sd-dialog--viewer');
  const tabEl = (key: Key) => q<HTMLButtonElement>('#ws-tab-' + key);
  const key = (el: Element | null, k: string, init: KeyboardEventInit = {}) => {
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    el?.dispatchEvent(ev);
    return ev;
  };
  async function openIt() {
    host.open.set(true);
    await settle();
  }

  afterEach(() => {
    fixture?.destroy();
    (fixture?.nativeElement as HTMLElement | undefined)?.remove();
    window.matchMedia = realMatchMedia;
    vi.restoreAllMocks();
  });

  describe('open and closed', () => {
    it('closed: no dialog; the projected panels exist as instances but are not in the document', () => {
      const before = projectedCreated;
      setup();
      expect(dialog()).toBeNull();
      expect(projectedCreated).toBe(before + 1);
      expect(host.tool()).toBeTruthy();
      expect(q('sd-fake-tool')).toBeNull();
    });

    it('open: a modal named by the kicker and the title, focus on the selected tab, the band before the header', async () => {
      setup();
      await openIt();
      const d = dialog();
      expect(d?.hasAttribute('open')).toBe(true);
      const names = (d?.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent?.trim());
      expect(names).toEqual(['Consultation tools', 'Bola Ade']);
      expect(document.getElementById(d?.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Female · 34 yrs');
      expect(document.activeElement).toBe(tabEl('notes'));
      const band = q('.ws-band.sd-dock');
      expect(band?.querySelector('#band-back')).not.toBeNull();
      const head = q('.ws-head');
      expect(band && head ? band.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
    });

    it('✕ and Esc emit closed; the projected instance survives a close and a reopen, in the document again', async () => {
      setup();
      await openIt();
      const tool = host.tool();
      q<HTMLButtonElement>(`[aria-label="${CLOSE}"]`)?.click();
      expect(host.closes).toBe(1);
      await settle();
      expect(dialog()).toBeNull();
      expect(q('sd-fake-tool')).toBeNull();
      await openIt();
      expect(host.tool()).toBe(tool);
      expect(q('sd-fake-tool')).not.toBeNull();
      key(document.activeElement, 'Escape');
      expect(host.closes).toBe(2);
    });

    it('a click on the scrim emits closed', async () => {
      setup();
      await openIt();
      const d = dialog();
      if (!d) throw new Error('no dialog');
      d.getBoundingClientRect = () => ({ left: 100, right: 200, top: 100, bottom: 200 }) as DOMRect;
      d.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
      d.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
      expect(host.closes).toBe(1);
    });
  });

  describe('its words come from the page', () => {
    it('kicker, title and closeLabel name the dialog and ✕; the tablist is named by the kicker unless tablistLabel is set', async () => {
      setup();
      host.kicker.set('Consultation notes');
      host.title.set('Dr Ade');
      await openIt();
      const d = dialog();
      const names = (d?.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent?.trim());
      expect(names).toEqual(['Consultation notes', 'Dr Ade']);
      expect(q('.ws-head h2')?.getAttribute('title')).toBe('Dr Ade');
      expect(document.querySelectorAll(`.ws-head [aria-label="${CLOSE}"]`).length).toBe(1);
      expect(q('[role="tablist"]')?.getAttribute('aria-label')).toBe('Consultation notes');
      host.tablistLabel.set('Notes');
      await settle();
      expect(q('[role="tablist"]')?.getAttribute('aria-label')).toBe('Notes');
    });

    it('shareText is the banner’s words', async () => {
      setup();
      host.sharing.set(true);
      await openIt();
      expect(q('.ws-share')?.textContent).toContain('You are sharing your screen.');
      host.recording.set(true);
      await settle();
      expect(q('.ws-share')?.textContent).toContain('You are sharing your screen and recording.');
    });

    it('with sharing unbound, the meta and the allergies stay while the banner shows', async () => {
      setup();
      host.banner.set(true);
      await openIt();
      expect(q('.ws-share')).not.toBeNull();
      expect(q('.ws-head')?.textContent).toContain('Female · 34 yrs');
      expect(q('.ws-head')?.textContent).toContain('Allergies: Penicillin');
    });

    it('a static title="…" stays off the host element (no tooltip over the whole workspace)', async () => {
      TestBed.configureTestingModule({ imports: [StaticTitleHost], providers: [provideSupadocIcons()] });
      const f = TestBed.createComponent(StaticTitleHost);
      const el = f.nativeElement as HTMLElement;
      document.body.appendChild(el);
      try {
        f.detectChanges();
        f.componentInstance.open.set(true);
        f.detectChanges();
        TestBed.inject(ApplicationRef).tick();
        await new Promise((r) => setTimeout(r));
        f.detectChanges();
        const d = dialog();
        expect(d?.open).toBe(true);
        expect(el.querySelector('sd-call-workspace')?.hasAttribute('title')).toBe(false);
        expect(d?.closest('[title]')).toBeNull();
        const names = (d?.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent?.trim());
        expect(names).toEqual([KICKER, 'Dr Ade']);
      } finally {
        f.destroy();
        el.remove();
      }
    });
  });

  describe('tab marks ({ mark, sr }, the words the page’s own)', () => {
    const dots = (k: Key) => Array.from(tabEl(k)?.querySelectorAll('span.rounded-full') ?? []).filter((s) => s.getAttribute('aria-hidden') === 'true');
    const words = (k: Key) => Array.from(tabEl(k)?.querySelectorAll('.sr-only') ?? []).map((s) => s.textContent);

    it('warn: the warning dot (.ws-flag-unsaved) and exactly the given words', async () => {
      setup();
      host.flags.set({ prescriptions: UNSAVED });
      await openIt();
      expect(dots('prescriptions').map((d) => d.classList.contains('ws-flag-unsaved'))).toEqual([true]);
      expect(words('prescriptions')).toEqual([', unsaved changes']);
    });

    it('live: a pulsing alert dot; new: a cerulean dot', async () => {
      setup();
      host.flags.set({ copilot: LIVE, labs: { mark: 'new', sr: ', new' } });
      await openIt();
      const live = dots('copilot');
      expect(live.length).toBe(1);
      expect(live[0]?.classList.contains('bg-alert')).toBe(true);
      expect(live[0]?.classList.contains('motion-safe:animate-pulse')).toBe(true);
      expect(words('copilot')).toEqual([', transcribing']);
      const fresh = dots('labs');
      expect(fresh.length).toBe(1);
      expect(fresh[0]?.classList.contains('bg-cerulean')).toBe(true);
      expect(fresh[0]?.classList.contains('ws-flag-unsaved')).toBe(false);
      expect(words('labs')).toEqual([', new']);
    });

    it('another app’s warn words need no shell change; an undefined entry renders nothing', async () => {
      setup();
      host.flags.set({ labs: { mark: 'warn', sr: ', not sent' }, notes: undefined });
      await openIt();
      expect(dots('labs').map((d) => d.classList.contains('ws-flag-unsaved'))).toEqual([true]);
      expect(words('labs')).toEqual([', not sent']);
      expect(dots('notes')).toEqual([]);
      expect(words('notes')).toEqual([]);
      expect(tabEl('notes')?.textContent?.trim()).toBe('Consultation Notes');
    });
  });

  describe('tabs', () => {
    it('six tabs with roles and a roving tabindex; arrows wrap, Home and End; selection writes the model', async () => {
      setup();
      await openIt();
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Consultation tools"] [role="tab"]'));
      expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Consultation Notes', 'Prescriptions', 'Lab requests', 'Follow-ups', 'Transcript & AI', 'Full EMR']);
      expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1', '-1']);
      key(tabEl('notes'), 'ArrowLeft');
      await settle();
      expect(host.tab()).toBe('record');
      expect(document.activeElement).toBe(tabEl('record'));
      key(tabEl('record'), 'ArrowRight');
      await settle();
      expect(host.tab()).toBe('notes');
      key(tabEl('notes'), 'End');
      await settle();
      expect(host.tab()).toBe('record');
      key(tabEl('record'), 'Home');
      await settle();
      expect(host.tab()).toBe('notes');
      expect(tabEl('notes')?.getAttribute('aria-selected')).toBe('true');
      expect(tabEl('record')?.getAttribute('aria-selected')).toBe('false');
    });

    it('aria-controls only for registered panels; panels hidden but the selected one; the same instance across a switch', async () => {
      setup();
      await openIt();
      expect(tabEl('notes')?.getAttribute('aria-controls')).toBe('ws-panel-notes');
      expect(tabEl('labs')?.getAttribute('aria-controls')).toBe('ws-panel-labs');
      expect(tabEl('copilot')?.getAttribute('aria-controls')).toBeNull();
      const notes = document.getElementById('ws-panel-notes');
      const labs = document.getElementById('ws-panel-labs');
      expect(notes?.getAttribute('role')).toBe('tabpanel');
      expect(notes?.getAttribute('aria-labelledby')).toBe('ws-tab-notes');
      expect(notes?.hidden).toBe(false);
      expect(labs?.hidden).toBe(true);
      const tool = host.tool();
      tabEl('labs')?.click();
      await settle();
      expect(notes?.hidden).toBe(true);
      expect(labs?.hidden).toBe(false);
      expect(host.tool()).toBe(tool);
    });

    it('marks say unsaved and transcribing in words too', async () => {
      setup();
      host.flags.set({ prescriptions: UNSAVED, copilot: LIVE });
      await openIt();
      expect(tabEl('prescriptions')?.textContent).toContain(', unsaved changes');
      expect(tabEl('copilot')?.textContent).toContain(', transcribing');
      expect(tabEl('labs')?.textContent?.trim()).toBe('Lab requests');
    });

    it('the strip reveal adjusts only the strip', async () => {
      setup();
      await openIt();
      const strip = q('[role="tablist"][aria-label="Consultation tools"]');
      const tab = tabEl('labs');
      if (!strip || !tab) throw new Error('no strip');
      let left = 0;
      Object.defineProperty(strip, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => (left = v) });
      strip.getBoundingClientRect = () => ({ left: 10, right: 310 }) as DOMRect;
      tab.getBoundingClientRect = () => ({ left: 290 - left, right: 390 - left }) as DOMRect;
      host.ws().showTab('labs');
      await settle();
      expect(left).toBe(80);
      expect(tab.getBoundingClientRect().right).toBe(310);
    });
  });

  describe('scroll memory', () => {
    const scroller = () => q('.ws-scroll');
    const scrollTo = (el: Element | null, top: number) => {
      if (!el) throw new Error('no element');
      el.scrollTop = top;
      el.dispatchEvent(new Event('scroll'));
    };

    it('per tab: across a tablist click, the keyboard and a model write from the host', async () => {
      setup();
      await openIt();
      scrollTo(scroller(), 120);
      tabEl('labs')?.click();
      await settle();
      expect(scroller()?.scrollTop).toBe(0);
      scrollTo(scroller(), 40);
      // A model write from the page: no select() involved.
      host.tab.set('notes');
      await settle();
      expect(scroller()?.scrollTop).toBe(120);
      // The keyboard, to a tab never scrolled.
      key(tabEl('notes'), 'ArrowRight');
      await settle();
      expect(host.tab()).toBe('prescriptions');
      expect(scroller()?.scrollTop).toBe(0);
      host.tab.set('labs');
      await settle();
      expect(scroller()?.scrollTop).toBe(40);
    });

    it('across a close and a reopen; a [data-ws-keep-scroll] element too (by key)', async () => {
      setup();
      await openIt();
      scrollTo(scroller(), 75);
      scrollTo(q('#kept'), 33);
      host.open.set(false);
      await settle();
      expect(dialog()).toBeNull();
      await openIt();
      expect(scroller()?.scrollTop).toBe(75);
      expect(q('#kept')?.scrollTop).toBe(33);
    });

    it('a kept element gets its offset back after a tab switch', async () => {
      setup();
      await openIt();
      scrollTo(q('#kept'), 33);
      tabEl('labs')?.click();
      await settle();
      const kept = q('#kept');
      if (kept) kept.scrollTop = 0;
      host.tab.set('notes');
      await settle();
      expect(q('#kept')?.scrollTop).toBe(33);
    });
  });

  describe('a panel’s sticky bar (2.4.11)', () => {
    /** The scroller 100-700 and, stuck to its bottom, the bar 600-690. */
    async function withBar() {
      setup();
      host.stickyBar.set(true);
      host.open.set(true);
      await settle();
      const scroller = document.querySelector<HTMLElement>('.ws-scroll') as HTMLElement;
      const bar = document.querySelector<HTMLElement>('#sticky-bar') as HTMLElement;
      vi.spyOn(bar, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
      box(scroller, 100, 700);
      box(bar, 600, 690);
      return { scroller, bar };
    }
    const box = (el: Element, top: number, bottom: number) =>
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect);
    const focusAt = async (selector: string, top: number, bottom: number) => {
      const el = document.querySelector<HTMLElement>(selector) as HTMLElement;
      box(el, top, bottom);
      el.focus();
      await settle();
      return el;
    };

    it('a field under the bar comes clear of it, by exactly what covers it (plus the gap)', async () => {
      const { scroller } = await withBar();
      await focusAt('#fake-field', 620, 668);
      expect(scroller.scrollTop).toBe(668 + 8 - 600);
    });

    it('one a few pixels into the bar moves too; one clear of it does not', async () => {
      const { scroller } = await withBar();
      await focusAt('#fake-field', 400, 448);
      expect(scroller.scrollTop).toBe(0);
      await focusAt('#in-notes', 560, 604);
      expect(scroller.scrollTop).toBe(604 + 8 - 600);
    });

    it('a taller bar (an alert in it) is measured, not assumed', async () => {
      const { scroller, bar } = await withBar();
      box(bar, 500, 690);
      await focusAt('#fake-field', 520, 568);
      expect(scroller.scrollTop).toBe(568 + 8 - 500);
    });

    it('a control taller than the room left keeps its start in view', async () => {
      const { scroller } = await withBar();
      await focusAt('#fake-field', 140, 660);
      expect(scroller.scrollTop).toBe(40);
    });

    it('the bar’s own controls never make the form jump', async () => {
      const { scroller } = await withBar();
      await focusAt('#in-bar', 620, 668);
      expect(scroller.scrollTop).toBe(0);
    });

    it('a tool’s own dialog is left alone (the top layer, not this scroller)', async () => {
      const { scroller } = await withBar();
      host.nested.set(true);
      await settle();
      await focusAt('#in-nested', 620, 668);
      expect(scroller.scrollTop).toBe(0);
    });

    it('a hidden panel’s bar counts for nothing', async () => {
      const { scroller, bar } = await withBar();
      vi.spyOn(bar, 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
      await focusAt('#fake-field', 620, 668);
      expect(scroller.scrollTop).toBe(0);
    });

    it('focus already gone by then: nothing moves', async () => {
      const { scroller } = await withBar();
      const field = document.querySelector<HTMLElement>('#fake-field') as HTMLElement;
      box(field, 620, 668);
      field.focus();
      document.querySelector<HTMLElement>('#in-notes')?.focus();
      box(document.querySelector('#in-notes') as Element, 200, 240);
      await settle();
      expect(scroller.scrollTop).toBe(0);
    });
  });

  describe('an explicit target', () => {
    it('showTab(key, id): scrolled into view, its [data-ws-focus] child focused; the remembered offset is NOT applied', async () => {
      setup();
      await openIt();
      tabEl('labs')?.click();
      await settle();
      const scroller = q('.ws-scroll');
      if (scroller) {
        scroller.scrollTop = 50;
        scroller.dispatchEvent(new Event('scroll'));
      }
      const target = q('#target');
      if (!target) throw new Error('no target');
      const spy = vi.fn();
      target.scrollIntoView = spy;
      host.tab.set('notes');
      await settle();
      if (scroller) {
        scroller.scrollTop = 200;
        scroller.dispatchEvent(new Event('scroll'));
      }
      host.tab.set('labs');
      await settle();
      if (scroller) scroller.scrollTop = 7;
      host.ws().showTab('notes', 'target');
      await settle();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ block: 'start' });
      expect(document.activeElement?.id).toBe('target-heading');
      expect(scroller?.scrollTop).toBe(7);
    });

    it('showTab(key): focus moves to the tab, never left on a hidden button or the body', async () => {
      setup();
      await openIt();
      const pressed = q<HTMLButtonElement>('#in-notes');
      pressed?.focus();
      expect(document.activeElement).toBe(pressed);
      host.ws().showTab('labs');
      await settle();
      expect(host.tab()).toBe('labs');
      expect(document.activeElement).toBe(tabEl('labs'));
      expect(document.activeElement).not.toBe(document.body);
    });

    it('showTab on the tab already selected still moves focus', async () => {
      setup();
      await openIt();
      q<HTMLButtonElement>('#in-notes')?.focus();
      host.ws().showTab('notes', 'target');
      await settle();
      expect(document.activeElement?.id).toBe('target-heading');
    });
  });

  describe('Esc', () => {
    it('inside a projected form that prevents it (a tool’s inline form): dismissed, not closed; the dialog stays open', async () => {
      setup();
      host.tab.set('labs');
      await openIt();
      const form = q('sd-fake-form form');
      expect(form).not.toBeNull();
      key(form, 'Escape');
      await settle();
      expect(host.cancels).toBe(1);
      expect(host.closes).toBe(0);
      expect(dialog()?.hasAttribute('open')).toBe(true);
    });

    it('during an IME composition: nothing closes; without one it closes', async () => {
      setup();
      await openIt();
      const field = q('#fake-field');
      const ev = key(field, 'Escape', { isComposing: true });
      expect(ev.defaultPrevented).toBe(true);
      expect(host.closes).toBe(0);
      key(field, 'Escape');
      expect(host.closes).toBe(1);
    });
  });

  it('hasOpenNestedDialog: an open <dialog> inside a panel counts; its own dialog does not', async () => {
    setup();
    await openIt();
    expect(host.ws().hasOpenNestedDialog()).toBe(false);
    host.nested.set(true);
    await settle();
    expect(host.ws().hasOpenNestedDialog()).toBe(true);
    host.nested.set(false);
    await settle();
    expect(host.ws().hasOpenNestedDialog()).toBe(false);
  });

  describe('the picture-in-picture', () => {
    it('only with a peer template, its layer and gutter following', async () => {
      setup();
      host.hasPeer.set(false);
      await openIt();
      expect(q('.ws-pip')).toBeNull();
      expect(q('.ws-scroll')?.getAttribute('data-pip')).toBe('none');
      host.hasPeer.set(true);
      await settle();
      expect(q('.sd-dock.ws-pip-layer .ws-pip #fake-peer')).not.toBeNull();
      expect(q('.ws-scroll')?.getAttribute('data-pip')).toBe('br');
    });

    it('Move cycles the corners and announces; data-pip follows', async () => {
      setup();
      await openIt();
      const move = q<HTMLButtonElement>('.ws-pill button');
      expect(move?.getAttribute('aria-label')).toContain('Bola Ade');
      const live = q('.ws-frame > [role="status"]');
      for (const [corner, words] of [['bl', 'bottom left'], ['tl', 'top left'], ['tr', 'top right'], ['br', 'bottom right']]) {
        move?.click();
        await settle();
        expect(q('.ws-pip')?.classList.contains('ws-pip--' + corner)).toBe(true);
        expect(q('.ws-scroll')?.getAttribute('data-pip')).toBe(corner);
        expect(live?.textContent).toContain(words);
      }
    });

    it('Hide: Show video in the band takes focus; Show: the pill button takes focus', async () => {
      setup();
      await openIt();
      const hide = document.querySelectorAll<HTMLButtonElement>('.ws-pill button')[1];
      expect(hide?.getAttribute('aria-label')).toBe('Hide video');
      hide?.click();
      await settle();
      expect(q('.ws-pip')?.classList.contains('ws-pip--hidden')).toBe(true);
      expect(q('.ws-scroll')?.getAttribute('data-pip')).toBe('none');
      const show = Array.from(document.querySelectorAll<HTMLButtonElement>('.ws-band button')).find((b) => b.textContent?.includes('Show video'));
      expect(document.activeElement).toBe(show);
      show?.click();
      await settle();
      expect(q('.ws-pip')?.classList.contains('ws-pip--hidden')).toBe(false);
      expect(document.activeElement).toBe(q('.ws-pill button'));
    });
  });

  describe('sharing the screen', () => {
    it('the banner (role=status) with Stop sharing, recording copy; the meta and the allergies go', async () => {
      setup();
      await openIt();
      expect(q('.ws-share')).toBeNull();
      expect(q('.ws-head')?.textContent).toContain('Allergies: Penicillin');
      host.sharing.set(true);
      await settle();
      const banner = q('.ws-share');
      expect(banner?.getAttribute('role')).toBe('status');
      expect(banner?.textContent).toContain(shareWords(false));
      host.recording.set(true);
      await settle();
      expect(banner?.textContent).toContain(shareWords(true));
      expect(q('.ws-head')?.textContent).toContain('Details hidden while you share your screen.');
      expect(q('.ws-head')?.textContent).not.toContain('Female');
      expect(q('.ws-head')?.textContent).not.toContain('Penicillin');
      banner?.querySelector('button')?.click();
      expect(host.stops).toBe(1);
    });
  });

  describe('layouts', () => {
    const COMPACT = '(orientation: landscape) and (max-height: 500px)';
    const DESKTOP = '(min-width: 1024px)';
    const TABLET = '(min-width: 640px)';

    it('desktop, tablet, phone, compact from the queries; narrow only for phone and compact', async () => {
      for (const [matching, layout, narrow] of [
        [[DESKTOP, TABLET], 'desktop', false],
        [[TABLET], 'tablet', false],
        [[], 'phone', true],
        [[COMPACT, TABLET], 'compact', true],
      ] as const) {
        media([...matching]);
        setup();
        await openIt();
        expect(q('.ws-frame')?.getAttribute('data-layout')).toBe(layout);
        expect(host.ws().narrow()).toBe(narrow);
        fixture.destroy();
        (fixture.nativeElement as HTMLElement).remove();
        TestBed.resetTestingModule();
      }
    });

    it('compact: ✕ and the allergy chip (dark, count + sr-only list) join the band row; the header goes, its words stay sr-only', async () => {
      media([COMPACT, TABLET]);
      setup();
      await openIt();
      expect(q('.ws-head')).toBeNull();
      const band = q('.ws-band');
      expect(band?.querySelector(`[aria-label="${CLOSE}"]`)).not.toBeNull();
      expect(band?.textContent).toContain('Allergies: Penicillin');
      expect(band?.querySelector('.rounded-pill')?.classList.contains('text-white')).toBe(true);
      const d = dialog();
      const names = (d?.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent?.trim());
      expect(names).toEqual(['Consultation tools', 'Bola Ade']);
      expect(document.getElementById(names.length ? (d?.getAttribute('aria-labelledby') ?? '').split(' ')[1] : '')?.closest('.sr-only')).not.toBeNull();
    });
  });

  it('a focused band control removed: focus goes to the selected tab', async () => {
    setup();
    host.bandExtra.set(true);
    await openIt();
    const mute = q<HTMLButtonElement>('#band-mute');
    mute?.focus();
    mute?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    host.bandExtra.set(false);
    await settle();
    expect(q('#band-mute')).toBeNull();
    expect(document.activeElement).toBe(tabEl('notes'));
  });

  describe('its stylesheet', () => {
    it('the ring is scoped to the shell’s chrome: never over the projected panels', () => {
      expect(WS_CSS).not.toContain('.ws-frame :is(');
      expect(WS_CSS).not.toContain('.ws-frame button');
      expect(WS_CSS).toContain(':is(.ws-top, .ws-share, .ws-pip) :is(button, [tabindex]):focus-visible');
    });

    it('tokens only: no hard-coded theme colours, no shadow token the doctor build does not emit', () => {
      for (const banned of ['#bbdefb', '#0b62e4', '#0a3d80', '--shadow-overlay']) expect(WS_CSS).not.toContain(banned);
      expect(WS_CSS).toContain('var(--sd-elev-overlay)');
    });

    it('never prints the workspace', () => {
      expect(WS_CSS).toContain('@media print { sd-call-workspace dialog { display: none !important; } }');
    });

    it('frozen size (plan X2): no longer than at 88f505a less the print rule rename; the new mark adds no rule', () => {
      expect(WS_CSS.length).toBeLessThanOrEqual(WS_CSS_MAX);
      expect(WS_CSS).not.toContain('.ws-flag-new');
      expect(WS_CSS).not.toContain('doc-call-workspace');
    });
  });
});
