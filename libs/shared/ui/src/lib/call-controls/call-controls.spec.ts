import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '../icons/icons';
import {
  CALL_CONTROL_REASON_MS,
  CallControl,
  CallControlId,
  CallControlsComponent,
  CallMenuItem,
} from './call-controls';

/** A ResizeObserver whose size the test sets. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;
  constructor(private readonly cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {
    /* sizes come from resize() */
  }
  unobserve(): void {
    /* not used */
  }
  disconnect(): void {
    this.disconnected = true;
  }
  resize(width: number, height = 64): void {
    this.cb([{ contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

const BASE: CallControl[] = [
  { id: 'mic', label: 'Mute', icon: 'mic' },
  { id: 'cam', label: 'Stop video', icon: 'video' },
  { id: 'share', label: 'Share screen', icon: 'monitor-smartphone', pressed: false, overflow: 'menu' },
  {
    id: 'captions',
    label: 'Captions',
    icon: 'captions',
    pressed: true,
    overflow: 'menu',
  },
  { id: 'documents', label: 'Documents', icon: 'file-text', badge: 2, overflow: 'menu' },
  { id: 'more', label: 'More', icon: 'ellipsis' },
  { id: 'end', label: 'End', ariaLabel: 'End call', icon: 'phone-off', tone: 'danger' },
];

/** What opens beside a rail clears it: 14px from a 44px control to a 4.5rem rail's edge, then 8px. */
const RAIL_GAP = 'mr-[1.375rem]';

const MENU: CallMenuItem[] = [
  { id: 'invite', label: 'Invite someone', icon: 'user-plus' },
  { id: 'fit-contain', label: 'Video: fit whole picture', checked: true, group: 'fit' },
  { id: 'fit-cover', label: 'Video: fill the frame', checked: false, group: 'fit' },
  { id: 'self', label: 'Hide my preview', checked: false },
];

@Component({
  imports: [CallControlsComponent],
  template: `
    <sd-call-controls
      [controls]="controls()"
      [menu]="menu()"
      [layout]="layout()"
      (pressed)="pressed.push($event)"
      (menuSelect)="selected.push($event)"
    />
    <button type="button" class="outside">Elsewhere</button>
  `,
})
class Host {
  readonly controls = signal<CallControl[]>(BASE);
  readonly menu = signal<CallMenuItem[]>(MENU);
  readonly layout = signal<'bar' | 'rail'>('bar');
  readonly pressed: CallControlId[] = [];
  readonly selected: string[] = [];
}

describe('CallControlsComponent', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;

  const buttons = () => [...el.querySelectorAll<HTMLButtonElement>('[role="toolbar"] [data-control]')];
  const control = (id: string) => el.querySelector<HTMLButtonElement>(`[data-control="${id}"]`) as HTMLButtonElement;
  const menuItems = () => [...el.querySelectorAll<HTMLElement>('[role="menu"] [data-entry]')];
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const key = async (target: HTMLElement, k: string) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    await render();
  };
  /** Report a new bar size and let the debounced (one frame) update land. */
  const resize = async (width: number) => {
    for (const ro of FakeResizeObserver.instances) ro.resize(width);
    await new Promise((r) => setTimeout(r, 40));
    await render();
  };
  const menuEl = () => el.querySelector<HTMLElement>('[role="menu"]') as HTMLElement;
  const classes = (e: HTMLElement) => [...e.classList];
  const openMore = async () => {
    control('more').click();
    await render();
  };
  const closeMore = async () => {
    await key(menuItems()[0], 'Escape');
  };

  /**
   * jsdom has no layout: give the viewport, More's wrapper (44px tall, from
   * `moreTop`) and the menu the sizes the test sets (read when the menu is fitted).
   */
  const geometry = { viewport: 768, moreTop: 0, menuHeight: 0 };
  const view = document.defaultView as Window;
  let innerHeight: PropertyDescriptor | undefined;
  const layOut = (g: Partial<typeof geometry>) => {
    Object.assign(geometry, g);
    Object.defineProperty(view, 'innerHeight', { configurable: true, writable: true, value: geometry.viewport });
  };
  const box = (top: number, height: number) =>
    ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 0, width: 0, height, toJSON: () => ({}) }) as DOMRect;
  /** The arguments of each focus() call on `target` (focus still happens). */
  let focusSpy: ReturnType<typeof vi.spyOn<HTMLElement, 'focus'>>;
  const focusCalls = (target: HTMLElement) =>
    focusSpy.mock.calls.filter((_, i) => focusSpy.mock.contexts[i] === target);
  /** Report a new rail height and let the debounced (one frame) update land. */
  const resizeRail = async (height: number) => {
    for (const ro of FakeResizeObserver.instances) ro.resize(72, height);
    await new Promise((r) => setTimeout(r, 40));
    await render();
  };

  beforeEach(async () => {
    innerHeight = Object.getOwnPropertyDescriptor(view, 'innerHeight');
    Object.assign(geometry, { viewport: 768, moreTop: 0, menuHeight: 0 });
    focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.getAttribute('role') === 'menu') return box(0, geometry.menuHeight);
      if (this.querySelector(':scope > [data-control="more"]')) return box(geometry.moreTop, 44);
      return box(0, 0);
    });
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideSupadocIcons()],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
  });

  afterEach(() => {
    el.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (innerHeight) Object.defineProperty(view, 'innerHeight', innerHeight);
    else delete (view as { innerHeight?: number }).innerHeight;
  });

  it('is a labelled toolbar whose every name starts with the visible label', () => {
    const bar = el.querySelector('[role="toolbar"]') as HTMLElement;
    expect(bar.getAttribute('aria-label')).toBe('Call controls');
    expect(bar.getAttribute('aria-orientation')).toBe('horizontal');
    for (const b of buttons()) {
      const label = b.querySelector(':scope > span:last-child')?.textContent?.trim() ?? '';
      expect(label.length).toBeGreaterThan(0);
      expect(b.getAttribute('aria-label')?.startsWith(label)).toBe(true);
    }
    expect(control('end').getAttribute('aria-label')).toBe('End call');
    // Labels follow the callbar container: screen-reader only until it is 34rem wide.
    expect(control('mic').querySelector(':scope > span:last-child')?.className).toContain('callbar:not-sr-only');
  });

  it('puts aria-pressed on toggles only; a pressed toggle keeps its label', async () => {
    expect(control('mic').hasAttribute('aria-pressed')).toBe(false);
    expect(control('share').getAttribute('aria-pressed')).toBe('false');
    expect(control('captions').getAttribute('aria-pressed')).toBe('true');

    host.controls.set([...BASE, { id: 'record', label: 'Record', icon: 'circle', pressed: true }]);
    await render();
    expect(control('record').getAttribute('aria-pressed')).toBe('true');
    expect(control('record').getAttribute('aria-label')).toBe('Record');
  });

  it('puts the badge in the name', () => {
    expect(control('documents').getAttribute('aria-label')).toBe('Documents, 2 new');
    expect(control('documents').textContent).toContain('2');
    expect(control('more').getAttribute('aria-label')).toBe('More');
  });

  it('has one tab stop and moves it with the arrow keys, Home and End', async () => {
    const tabStops = () => buttons().filter((b) => b.tabIndex === 0).map((b) => b.dataset['control']);
    expect(tabStops()).toEqual(['mic']);

    control('mic').focus();
    await key(control('mic'), 'ArrowRight');
    expect(document.activeElement).toBe(control('cam'));
    expect(tabStops()).toEqual(['cam']);
    await key(control('cam'), 'End');
    expect(document.activeElement).toBe(control('end'));
    await key(control('end'), 'ArrowRight'); // wraps
    expect(document.activeElement).toBe(control('mic'));
    await key(control('mic'), 'ArrowLeft');
    expect(document.activeElement).toBe(control('end'));
    await key(control('end'), 'Home');
    expect(document.activeElement).toBe(control('mic'));
  });

  it('emits pressed for a control', () => {
    control('mic').click();
    control('end').click();
    expect(host.pressed).toEqual(['mic', 'end']);
  });

  it('opens the More menu: radios, checkboxes, arrow keys, Esc back to More', async () => {
    const more = control('more');
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.click();
    await render();

    const menu = el.querySelector('[role="menu"]') as HTMLElement;
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(menu.getAttribute('aria-labelledby')).toBe(more.id);
    expect(menuItems().map((i) => i.getAttribute('role'))).toEqual([
      'menuitem',
      'menuitemradio',
      'menuitemradio',
      'menuitemcheckbox',
    ]);
    expect(menuItems()[1].getAttribute('aria-checked')).toBe('true');
    expect(menuItems()[2].getAttribute('aria-checked')).toBe('false');
    expect(menuItems()[3].getAttribute('aria-checked')).toBe('false');
    expect(menuItems()[0].hasAttribute('aria-checked')).toBe(false);
    expect(menu.querySelector('[role="group"]')?.querySelectorAll('[role="menuitemradio"]').length).toBe(2);
    expect(document.activeElement).toBe(menuItems()[0]);

    await key(menuItems()[0], 'ArrowDown');
    expect(document.activeElement).toBe(menuItems()[1]);
    await key(menuItems()[1], 'End');
    expect(document.activeElement).toBe(menuItems()[3]);
    await key(menuItems()[3], 'ArrowDown'); // wraps
    expect(document.activeElement).toBe(menuItems()[0]);

    await key(menuItems()[0], 'Escape');
    expect(el.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(host.pressed).toEqual([]);
  });

  it('emits menuSelect for an item and closes; a click outside closes too', async () => {
    control('more').click();
    await render();
    menuItems()[2].click();
    await render();
    expect(host.selected).toEqual(['fit-cover']);
    expect(el.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(control('more'));

    control('more').click();
    await render();
    (el.querySelector('.outside') as HTMLButtonElement).click();
    await render();
    expect(el.querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps a disabled control focusable, describes it, and shows its reason when pressed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    host.controls.set(
      BASE.map((c) =>
        c.id === 'captions'
          ? { ...c, pressed: false, disabled: true, reason: 'Turn on captions consent in Privacy & consent first.' }
          : c,
      ),
    );
    fixture.detectChanges();
    const captions = control('captions');
    expect(captions.disabled).toBe(false);
    expect(captions.getAttribute('aria-disabled')).toBe('true');
    const described = el.querySelector(`#${captions.getAttribute('aria-describedby')}`);
    expect(described?.textContent).toContain('captions consent');
    expect(captions.hasAttribute('title')).toBe(false);

    captions.click();
    fixture.detectChanges();
    expect(host.pressed).toEqual([]);
    const status = [...el.querySelectorAll('[role="status"]')].find((s) => s.textContent?.trim());
    expect(status?.textContent).toContain('Turn on captions consent');

    vi.advanceTimersByTime(CALL_CONTROL_REASON_MS);
    fixture.detectChanges();
    expect([...el.querySelectorAll('[role="status"]')].every((s) => !s.textContent?.trim())).toBe(true);
  });

  it('at 320px moves overflow controls into More (first, as checkboxes) and back at 600px', async () => {
    expect(FakeResizeObserver.instances.length).toBe(1);
    await resize(320);

    expect(buttons().map((b) => b.dataset['control'])).toEqual(['mic', 'cam', 'more', 'end']);
    // The overflowed Documents badge is added to More's.
    expect(control('more').getAttribute('aria-label')).toBe('More, 2 new');
    expect(control('more').textContent).toContain('2');

    control('more').click();
    await render();
    const items = menuItems();
    expect(items.slice(0, 3).map((i) => [i.getAttribute('role'), i.getAttribute('aria-label'), i.getAttribute('aria-checked')])).toEqual([
      ['menuitemcheckbox', 'Share screen', 'false'],
      ['menuitemcheckbox', 'Captions', 'true'],
      ['menuitem', 'Documents, 2 new', null],
    ]);
    expect(items[3].getAttribute('aria-label')).toBe('Invite someone');

    items[0].click();
    await render();
    expect(host.pressed).toEqual(['share']);
    expect(host.selected).toEqual([]);

    await resize(600);
    expect(buttons().map((b) => b.dataset['control'])).toEqual(['mic', 'cam', 'share', 'captions', 'documents', 'more', 'end']);
    expect(control('more').getAttribute('aria-label')).toBe('More');
  });

  it('a disabled overflowed control shows its reason on More', async () => {
    host.controls.set(BASE.map((c) => (c.id === 'share' ? { ...c, disabled: true, reason: 'Screen sharing is off.' } : c)));
    await resize(320);
    control('more').click();
    await render();
    const share = menuItems()[0];
    expect(share.getAttribute('aria-disabled')).toBe('true');
    expect(el.querySelector(`#${share.getAttribute('aria-describedby')}`)?.textContent).toContain('Screen sharing is off.');
    share.click();
    await render();
    expect(host.pressed).toEqual([]);
    const moreWrap = control('more').parentElement as HTMLElement;
    expect(moreWrap.querySelector('[role="status"]')?.textContent).toContain('Screen sharing is off.');
  });

  it('ignores overflow without a More control', async () => {
    host.controls.set(BASE.filter((c) => c.id !== 'more'));
    await resize(320);
    expect(buttons().map((b) => b.dataset['control'])).toContain('share');
  });

  it('is vertical in a rail, judged by its height', async () => {
    host.layout.set('rail');
    await render();
    expect(el.querySelector('[role="toolbar"]')?.getAttribute('aria-orientation')).toBe('vertical');
    for (const ro of FakeResizeObserver.instances) ro.resize(600, 300);
    await new Promise((r) => setTimeout(r, 40));
    await render();
    expect(buttons().map((b) => b.dataset['control'])).not.toContain('share');
    control('mic').focus();
    await key(control('mic'), 'ArrowDown');
    expect(document.activeElement).toBe(control('cam'));
  });

  it('opens the More menu above the bar, right-aligned to More, as before', async () => {
    // Even with a layout that would move a rail's menu, the bar's never moves.
    layOut({ viewport: 320, moreTop: 150, menuHeight: 304 });
    await openMore();
    const menu = menuEl();
    expect(classes(menu)).toEqual(expect.arrayContaining(['absolute', 'z-40', 'right-0', 'bottom-full', 'mb-2']));
    for (const c of [
      'right-full',
      'mr-2',
      RAIL_GAP,
      'top-0',
      'bottom-0',
      'top-full',
      'mt-2',
      'max-h-[calc(100dvh-1rem)]',
      'overflow-y-auto',
    ]) {
      expect(classes(menu)).not.toContain(c);
    }
    expect(menu.style.bottom).toBe('');
    expect(document.activeElement).toBe(menuItems()[0]);
    // Focused as before (the page may scroll to it); only a rail's skips that.
    expect(focusCalls(menuItems()[0])).toEqual([[]]);

    window.dispatchEvent(new Event('resize'));
    await render();
    expect(classes(menuEl())).toEqual(expect.arrayContaining(['right-0', 'bottom-full', 'mb-2']));
    expect(menuEl().style.bottom).toBe('');
  });

  it('in a rail opens More beside it, toward the video, never taller than the screen; keys still work', async () => {
    host.layout.set('rail');
    await render();
    await openMore();
    const menu = menuEl();
    // Left of the rail (on the right edge) and clear of it, its bottom on More's, scrolling inside past the screen's height.
    expect(classes(menu)).toEqual(
      expect.arrayContaining(['absolute', 'z-40', 'right-full', RAIL_GAP, 'bottom-0', 'max-h-[calc(100dvh-1rem)]', 'overflow-y-auto']),
    );
    for (const c of ['right-0', 'mr-2', 'top-full', 'mt-2', 'bottom-full', 'mb-2', 'top-0']) {
      expect(classes(menu)).not.toContain(c);
    }
    expect(menu.style.bottom).toBe('');
    // Focused without scrolling the page: the menu is placed for the screen as it is.
    expect(focusCalls(menuItems()[0])).toEqual([[{ preventScroll: true }]]);

    expect(control('more').getAttribute('aria-expanded')).toBe('true');
    expect(menuItems().map((i) => i.getAttribute('role'))).toEqual(['menuitem', 'menuitemradio', 'menuitemradio', 'menuitemcheckbox']);
    expect(menuItems()[1].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(menuItems()[0]);
    await key(menuItems()[0], 'ArrowUp'); // wraps
    expect(document.activeElement).toBe(menuItems()[3]);
    await key(menuItems()[3], 'Home');
    expect(document.activeElement).toBe(menuItems()[0]);
    await closeMore();
    expect(el.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(control('more'));
  });

  it('keeps a rail menu on screen: bottom on More, else top on More, else as near as fits', async () => {
    host.layout.set('rail');
    await render();

    // 812x375: More's bottom at 259, a 200px menu fits above it.
    layOut({ viewport: 375, moreTop: 215, menuHeight: 200 });
    await openMore();
    expect(classes(menuEl())).toContain('bottom-0');
    expect(classes(menuEl())).not.toContain('top-0');
    expect(menuEl().style.bottom).toBe('');
    await closeMore();

    // More near the top: above it would leave the screen, below it fits (60 + 200 <= 375 - 8).
    layOut({ moreTop: 60 });
    await openMore();
    expect(classes(menuEl())).toContain('top-0');
    expect(classes(menuEl())).not.toContain('bottom-0');
    expect(menuEl().style.bottom).toBe('');
    await closeMore();

    // 568x320, a screen-high menu: neither edge fits, so it is pinned 8px from the top:
    // its bottom 118px below More's (194 + 118 - 304 = 8; 8 + 304 = 320 - 8).
    layOut({ viewport: 320, moreTop: 150, menuHeight: 304 });
    control('more').click();
    // Fitted in the render that opens it (one pass), never shown at a spot it then leaves.
    fixture.detectChanges();
    expect(menuEl().style.bottom).toBe('-118px');
    await render();
    expect(classes(menuEl())).toEqual(expect.arrayContaining(['right-full', RAIL_GAP, 'bottom-0', 'max-h-[calc(100dvh-1rem)]']));
    expect(menuEl().style.bottom).toBe('-118px');
    expect(document.activeElement).toBe(menuItems()[0]);
  });

  it("keeps a scrolling rail menu's separators and groups at their height", async () => {
    host.layout.set('rail');
    await render();
    layOut({ viewport: 320, moreTop: 150, menuHeight: 304 });
    await openMore();
    // The menu is a flex column that scrolls inside: anything in it that may shrink
    // (the empty separators most of all) would, and the groups would run together.
    // jsdom has no layout, so the classes are what can be checked.
    const parts = [...menuEl().children] as HTMLElement[];
    expect(parts.map((p) => p.getAttribute('role'))).toEqual(['none', 'separator', 'group', 'separator', 'none']);
    for (const p of parts) expect(classes(p)).toContain('shrink-0');
  });

  it('refits an open rail menu when the rail resizes (a banner above the dock moves More)', async () => {
    host.layout.set('rail');
    await render();
    // 812x375, a menu taller than either side of More allows: pinned 8px from the top,
    // its bottom 114px below More's (194 - 8 - 300).
    layOut({ viewport: 375, moreTop: 150, menuHeight: 300 });
    await openMore();
    expect(menuEl().style.bottom).toBe('-114px');

    // A 40px banner above the dock: the rail is 40px shorter and its centred More 20px
    // lower. Still not compact (no new items, no window resize): only the rail moved.
    layOut({ moreTop: 170 });
    await resizeRail(360);
    expect(menuItems().length).toBe(4);
    expect(menuEl().style.bottom).toBe('-94px');

    // The banner goes: More back up, the menu with it.
    layOut({ moreTop: 150 });
    await resizeRail(400);
    expect(menuEl().style.bottom).toBe('-114px');
  });

  it('refits an open rail menu when its items change', async () => {
    host.layout.set('rail');
    await render();
    layOut({ viewport: 375, moreTop: 215, menuHeight: 200 });
    await openMore();
    expect(classes(menuEl())).toContain('bottom-0');
    expect(menuEl().style.bottom).toBe('');

    // Two more items while it is open: 330px, too tall for either side of More;
    // pinned 8px from the top (259 - 8 - 330 = -79).
    layOut({ menuHeight: 330 });
    host.menu.set([...MENU, { id: 'a', label: 'Item A' }, { id: 'b', label: 'Item B' }]);
    await render();
    expect(menuItems().length).toBe(6);
    expect(menuEl().style.bottom).toBe('-79px');
  });

  it("shows a rail control's reason beside the rail, clear of it", async () => {
    host.layout.set('rail');
    host.controls.set(BASE.map((c) => (c.id === 'cam' ? { ...c, disabled: true, reason: 'Your camera is blocked.' } : c)));
    await render();
    control('cam').click();
    await render();
    const status = (control('cam').parentElement as HTMLElement).querySelector('[role="status"]') as HTMLElement;
    expect(status.textContent).toContain('Your camera is blocked.');
    expect(classes(status)).toEqual(expect.arrayContaining(['right-full', RAIL_GAP, 'top-1/2']));
    expect(classes(status)).not.toContain('mr-2');
  });

  it('refits an open rail menu when the window resizes, and drops it when the bar comes back', async () => {
    host.layout.set('rail');
    await render();
    layOut({ viewport: 375, moreTop: 215, menuHeight: 200 });
    await openMore();
    expect(menuEl().style.bottom).toBe('');

    // The screen shrinks to 250: neither edge fits; pinned 8px from its bottom (242 - 200 = 42 from the top).
    layOut({ viewport: 250 });
    window.dispatchEvent(new Event('resize'));
    await render();
    expect(classes(menuEl())).toContain('bottom-0');
    expect(menuEl().style.bottom).toBe('17px');

    // Turned upright with the menu open: the bar's placement, with no rail offset left over.
    host.layout.set('bar');
    await render();
    expect(classes(menuEl())).toEqual(expect.arrayContaining(['right-0', 'bottom-full', 'mb-2']));
    expect(classes(menuEl())).not.toContain('right-full');
    expect(classes(menuEl())).not.toContain('max-h-[calc(100dvh-1rem)]');
    expect(menuEl().style.bottom).toBe('');

    // And back sideways: fitted again.
    host.layout.set('rail');
    await render();
    expect(classes(menuEl())).toContain('right-full');
    expect(menuEl().style.bottom).toBe('17px');
  });

  it('disconnects its ResizeObserver when destroyed', () => {
    fixture.destroy();
    expect(FakeResizeObserver.instances.every((ro) => ro.disconnected)).toBe(true);
  });
});
