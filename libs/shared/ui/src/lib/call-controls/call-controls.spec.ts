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

  beforeEach(async () => {
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

  it('disconnects its ResizeObserver when destroyed', () => {
    fixture.destroy();
    expect(FakeResizeObserver.instances.every((ro) => ro.disconnected)).toBe(true);
  });
});
