import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '../icons/icons';
import {
  CALL_CONTROL_REASON_MS,
  CallChoiceChange,
  CallControl,
  CallControlId,
  CallControlsComponent,
  CallSetting,
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
  { id: 'share', label: 'Share screen', icon: 'monitor-smartphone', pressed: false },
  { id: 'captions', label: 'Captions', icon: 'captions', pressed: true },
  { id: 'documents', label: 'Documents', icon: 'file-text', badge: 2 },
  { id: 'end', label: 'End', ariaLabel: 'End call', icon: 'phone-off', tone: 'danger' },
];

const SETTINGS: CallSetting[] = [
  {
    id: 'size',
    label: 'Video size',
    value: 'l',
    options: [
      { value: 's', label: 'Small', ariaLabel: 'Small video' },
      { value: 'm', label: 'Medium', ariaLabel: 'Medium video' },
      { value: 'l', label: 'Large', ariaLabel: 'Large video' },
    ],
  },
  {
    id: 'fit',
    label: 'Video fit',
    value: 'cover',
    options: [
      { value: 'contain', label: 'Fit', ariaLabel: 'Fit whole picture' },
      { value: 'cover', label: 'Fill', ariaLabel: 'Fill the frame' },
    ],
  },
  { id: 'self', label: 'Hide my preview', icon: 'eye-off', pressed: false },
  { id: 'privacy', label: 'Privacy', ariaLabel: 'Privacy & consent', icon: 'shield-check' },
];

/** What opens beside a rail clears it: 14px from a column-one control to the rail's edge, then 8px. */
const RAIL_GAP = 'mr-[1.375rem]';

@Component({
  imports: [CallControlsComponent],
  template: `
    <sd-call-controls
      [controls]="controls()"
      [settings]="settings()"
      [layout]="layout()"
      (pressed)="pressed.push($event)"
      (choiceChange)="chosen.push($event)"
    />
  `,
})
class Host {
  readonly controls = signal<CallControl[]>(BASE);
  readonly settings = signal<CallSetting[]>(SETTINGS);
  readonly layout = signal<'bar' | 'rail'>('bar');
  readonly pressed: CallControlId[] = [];
  readonly chosen: CallChoiceChange[] = [];
}

describe('CallControlsComponent', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;
  /** jsdom has no layout: the toolbar's width and each item's width, as the test sets them. */
  const geometry = { toolbar: 0, item: 0 };

  const toolbar = () => el.querySelector('[role="toolbar"]') as HTMLElement;
  const buttons = () => [...el.querySelectorAll<HTMLButtonElement>('[role="toolbar"] [data-control]')];
  const control = (id: string) => el.querySelector<HTMLButtonElement>(`[data-control="${id}"]`) as HTMLButtonElement;
  const radio = (choice: string, value: string) =>
    el.querySelector<HTMLButtonElement>(`[data-choice="${choice}"][data-value="${value}"]`) as HTMLButtonElement;
  const stops = () => [...el.querySelectorAll<HTMLElement>('[data-stop]')];
  const tabStops = () => stops().filter((b) => b.tabIndex === 0).map((b) => b.dataset['stop']);
  const settingsGroup = () => el.querySelector<HTMLElement>('[data-box="settings"]') as HTMLElement;
  const divider = () => el.querySelector<HTMLElement>('[data-divider]');
  const classes = (e: Element | null) => [...(e?.classList ?? [])];
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const key = async (target: HTMLElement, k: string) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    await render();
  };
  /** Report a new size and let the debounced (one frame) update land. */
  const resize = async (width: number, height = 64) => {
    for (const ro of FakeResizeObserver.instances) ro.resize(width, height);
    await new Promise((r) => setTimeout(r, 40));
    await render();
  };
  /** The columns of a box in a rail: the labels of the items in each. */
  const columns = (box: 'controls' | 'settings') =>
    [...el.querySelectorAll<HTMLElement>(`[data-box="${box}"] > div`)].map((col) =>
      [...col.querySelectorAll<HTMLElement>(':scope > [data-item]')].map(
        (item) => item.querySelector('[data-control]')?.getAttribute('data-control') ?? item.querySelector('[role="radiogroup"]')?.getAttribute('aria-label'),
      ),
    );

  beforeEach(async () => {
    Object.assign(geometry, { toolbar: 0, item: 0 });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const width = this.hasAttribute('data-item') ? geometry.item : 0;
      return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: width, width, height: 0, toJSON: () => ({}) } as DOMRect;
    });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.getAttribute('role') === 'toolbar' ? geometry.toolbar : 0;
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
  });

  it('has no More: every control and setting is in the toolbar, nothing in a menu', () => {
    expect(el.querySelector('[data-control="more"]')).toBeNull();
    expect(el.querySelector('[role="menu"], [aria-haspopup]')).toBeNull();
    expect(buttons().map((b) => b.dataset['control'])).toEqual(['mic', 'cam', 'share', 'captions', 'documents', 'end', 'self', 'privacy']);
    expect(el.querySelectorAll('[role="radiogroup"]')).toHaveLength(2);
    // Every one is a stop of the toolbar's roving tab order (buttons, then each option).
    expect(stops().map((s) => s.dataset['stop'])).toEqual([
      'c:mic',
      'c:cam',
      'c:share',
      'c:captions',
      'c:documents',
      'c:end',
      'r:size:s',
      'r:size:m',
      'r:size:l',
      'r:fit:contain',
      'r:fit:cover',
      'c:self',
      'c:privacy',
    ]);
  });

  it('is a labelled toolbar whose every name starts with the visible label', () => {
    expect(toolbar().getAttribute('aria-label')).toBe('Call controls');
    expect(toolbar().getAttribute('aria-orientation')).toBe('horizontal');
    for (const b of buttons()) {
      const label = b.querySelector(':scope > span:last-child')?.textContent?.trim() ?? '';
      expect(label.length).toBeGreaterThan(0);
      expect(b.getAttribute('aria-label')?.startsWith(label)).toBe(true);
    }
    for (const r of el.querySelectorAll<HTMLElement>('[role="radio"]')) {
      const label = r.textContent?.trim() ?? '';
      expect(label.length).toBeGreaterThan(0);
      expect(r.getAttribute('aria-label')?.startsWith(label)).toBe(true);
    }
    expect(control('end').getAttribute('aria-label')).toBe('End call');
    expect(control('privacy').getAttribute('aria-label')).toBe('Privacy & consent');
    // Labels follow the callbar container: screen-reader only until it is 34rem wide.
    expect(control('mic').querySelector(':scope > span:last-child')?.className).toContain('callbar:not-sr-only');
  });

  it('groups the settings after the controls, past a divider, at a lighter weight', () => {
    expect(settingsGroup().getAttribute('role')).toBe('group');
    expect(settingsGroup().getAttribute('aria-label')).toBe('Call settings');
    expect(settingsGroup().contains(control('self'))).toBe(true);
    expect(settingsGroup().contains(control('end'))).toBe(false);
    expect(divider()?.getAttribute('aria-hidden')).toBe('true');
    expect(divider()?.nextElementSibling).toBe(settingsGroup());
    const circle = (id: string) => control(id).firstElementChild as HTMLElement;
    // Call controls are filled circles; settings outlined, white while pressed.
    expect(classes(circle('mic'))).toContain('bg-white/10');
    expect(classes(circle('end'))).toContain('bg-alert');
    expect(classes(circle('self'))).toEqual(expect.arrayContaining(['border', 'border-white/15']));
    expect(classes(circle('self'))).not.toContain('bg-white/10');
  });

  it('leaves the divider and the group out when there are no settings', async () => {
    host.settings.set([]);
    await render();
    expect(divider()).toBeNull();
    expect(el.querySelector('[data-box="settings"]')).toBeNull();
    expect(buttons()).toHaveLength(6);
  });

  it('puts aria-pressed on toggles only (a call control or a setting); a pressed toggle keeps its label', async () => {
    expect(control('mic').hasAttribute('aria-pressed')).toBe(false);
    expect(control('privacy').hasAttribute('aria-pressed')).toBe(false);
    expect(control('share').getAttribute('aria-pressed')).toBe('false');
    expect(control('captions').getAttribute('aria-pressed')).toBe('true');
    expect(control('self').getAttribute('aria-pressed')).toBe('false');

    host.settings.set(SETTINGS.map((s) => (s.id === 'self' ? { ...s, pressed: true } : s)));
    await render();
    expect(control('self').getAttribute('aria-pressed')).toBe('true');
    expect(control('self').getAttribute('aria-label')).toBe('Hide my preview');
    expect(classes(control('self').firstElementChild)).toEqual(expect.arrayContaining(['bg-white', 'text-ink']));
  });

  it('puts the badge in the name', () => {
    expect(control('documents').getAttribute('aria-label')).toBe('Documents, 2 new');
    expect(control('documents').textContent).toContain('2');
  });

  it('shows a segmented choice as a labelled radio group, the chosen option checked', () => {
    const size = el.querySelector('[role="radiogroup"][aria-label="Video size"]') as HTMLElement;
    expect([...size.querySelectorAll('[role="radio"]')].map((r) => [r.textContent?.trim(), r.getAttribute('aria-checked')])).toEqual([
      ['Small', 'false'],
      ['Medium', 'false'],
      ['Large', 'true'],
    ]);
    expect(radio('fit', 'cover').getAttribute('aria-checked')).toBe('true');
    expect(radio('fit', 'cover').getAttribute('aria-label')).toBe('Fill the frame');
    // The look comes from the dock pill and its ARIA state (tailwind/pills.css), not from colour classes.
    expect(classes(radio('fit', 'cover'))).toEqual(expect.arrayContaining(['sd-pill', 'sd-pill-dock']));
    expect(radio('fit', 'contain').getAttribute('aria-checked')).toBe('false');
    expect(classes(radio('fit', 'contain'))).not.toContain('bg-white');
    // The group's caption follows the labels (screen-reader only below 34rem; the group is named anyway).
    const caption = size.nextElementSibling as HTMLElement;
    expect(caption.textContent?.trim()).toBe('Video size');
    expect(caption.getAttribute('aria-hidden')).toBe('true');
  });

  it('emits pressed for a control and for a setting button', () => {
    control('mic').click();
    control('self').click();
    control('privacy').click();
    control('end').click();
    expect(host.pressed).toEqual(['mic', 'self', 'privacy', 'end']);
  });

  it('emits choiceChange for another option (not the chosen one)', () => {
    radio('size', 's').click();
    radio('size', 'l').click();
    radio('fit', 'contain').click();
    expect(host.chosen).toEqual([
      { id: 'size', value: 's' },
      { id: 'fit', value: 'contain' },
    ]);
    expect(host.pressed).toEqual([]);
  });

  it('has one tab stop and moves it across controls, options and settings with the arrows, Home and End', async () => {
    expect(tabStops()).toEqual(['c:mic']);
    control('mic').focus();
    await key(control('mic'), 'ArrowRight');
    expect(document.activeElement).toBe(control('cam'));
    expect(tabStops()).toEqual(['c:cam']);
    await key(control('cam'), 'End');
    expect(document.activeElement).toBe(control('privacy'));
    await key(control('privacy'), 'ArrowRight'); // wraps
    expect(document.activeElement).toBe(control('mic'));
    await key(control('mic'), 'ArrowLeft');
    expect(document.activeElement).toBe(control('privacy'));
    await key(control('privacy'), 'ArrowLeft');
    expect(document.activeElement).toBe(control('self'));
    await key(control('self'), 'ArrowLeft');
    expect(document.activeElement).toBe(radio('fit', 'cover'));
    expect(tabStops()).toEqual(['r:fit:cover']);
    await key(radio('fit', 'cover'), 'ArrowLeft');
    expect(document.activeElement).toBe(radio('fit', 'contain'));
    expect(host.chosen).toEqual([]); // the toolbar's arrows only move focus
    await key(radio('fit', 'contain'), 'Home');
    expect(document.activeElement).toBe(control('mic'));
  });

  it('on an option, Up / Down choose the previous / next one (wrapping) and focus it', async () => {
    radio('size', 'l').focus();
    await key(radio('size', 'l'), 'ArrowDown');
    expect(host.chosen).toEqual([{ id: 'size', value: 's' }]);
    expect(document.activeElement).toBe(radio('size', 's'));
    await key(radio('size', 's'), 'ArrowUp');
    expect(document.activeElement).toBe(radio('size', 'l'));
    await key(radio('size', 'l'), 'ArrowUp');
    expect(document.activeElement).toBe(radio('size', 'm'));
    // (The host keeps Large chosen: going back to it is no change.)
    expect(host.chosen).toEqual([
      { id: 'size', value: 's' },
      { id: 'size', value: 'm' },
    ]);
    // Not on an option: Up / Down do nothing.
    control('mic').focus();
    await key(control('mic'), 'ArrowDown');
    expect(document.activeElement).toBe(control('mic'));
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
    // No tooltip over the reason.
    expect(classes((captions.parentElement as HTMLElement).querySelector('[data-tip]'))).toContain('hidden');

    vi.advanceTimersByTime(CALL_CONTROL_REASON_MS);
    fixture.detectChanges();
    expect([...el.querySelectorAll('[role="status"]')].every((s) => !s.textContent?.trim())).toBe(true);
  });

  it("keeps a shown reason on a phone's screen: moved along the bar (down a rail) as far as it takes", async () => {
    const screen = { width: 320, height: 320 };
    /** Where each reason sits unmoved (as laid out: 256px wide, 40px tall), plus its inline move. */
    const natural: Record<string, { left: number; top: number }> = {
      captions: { left: 135, top: 200 },
      mic: { left: -100, top: 200 },
      cam: { left: 40, top: 290 },
    };
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this === document.documentElement ? screen.width : this.getAttribute('role') === 'toolbar' ? geometry.toolbar : 0;
    });
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
      return this === document.documentElement ? screen.height : 0;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const id = this.getAttribute('data-reason');
      const at = id && this.textContent?.trim() ? natural[id] : null;
      if (!at) return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
      const style = (this as HTMLElement).style;
      const left = at.left + (parseFloat(style.marginLeft) || 0);
      const top = at.top + (parseFloat(style.marginTop) || 0);
      return { x: left, y: top, left, top, right: left + 256, bottom: top + 40, width: 256, height: 40, toJSON: () => ({}) } as DOMRect;
    });
    const reason = 'Not available yet.';
    host.controls.set(BASE.map((c) => (['captions', 'mic', 'cam'].includes(c.id) ? { ...c, disabled: true, reason } : c)));
    await render();
    const bubble = (id: string) => el.querySelector<HTMLElement>(`[data-reason="${id}"]`) as HTMLElement;

    // Captions near the right edge of a 320px screen: 135–391 unmoved, so 79px left, 8px clear of it.
    control('captions').click();
    await render();
    expect(bubble('captions').textContent).toContain(reason);
    expect(bubble('captions').style.marginLeft).toBe('-79px');
    expect(classes(bubble('captions'))).toContain('max-w-[min(16rem,calc(100vw-2rem))]');
    // Off the left edge: moved right; one that fits stays put (another's move is dropped).
    control('mic').click();
    await render();
    expect(bubble('mic').style.marginLeft).toBe('108px');
    expect(bubble('captions').style.marginLeft).toBe('');
    natural['mic'] = { left: 30, top: 200 };
    control('captions').click();
    await render();
    control('mic').click();
    await render();
    expect(bubble('mic').style.marginLeft).toBe('');

    // A rail: down the screen instead (290–330 on a 320px tall one: 18px up).
    host.layout.set('rail');
    await render();
    control('cam').click();
    await render();
    expect(bubble('cam').style.marginTop).toBe('-18px');
    expect(bubble('cam').style.marginLeft).toBe('');
  });

  it('icon only: a tooltip names each button on hover / keyboard focus, hidden by Esc until focus moves', async () => {
    const tip = (id: string) => (control(id).parentElement as HTMLElement).querySelector('[data-tip]') as HTMLElement;
    expect(tip('mic').textContent?.trim()).toBe('Mute');
    expect(tip('mic').getAttribute('aria-hidden')).toBe('true');
    expect(classes(tip('mic'))).toEqual(expect.arrayContaining(['hidden', 'group-hover/item:block', 'peer-focus-visible:block', 'callbar:hidden!']));
    // A sibling of the button: pointing at it never presses anything.
    expect(control('mic').contains(tip('mic'))).toBe(false);
    control('mic').focus();
    await key(control('mic'), 'Escape');
    expect(classes(tip('mic'))).toEqual(['hidden']);
    toolbar().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await render();
    expect(classes(tip('mic'))).toContain('peer-focus-visible:block');
  });

  it('keeps both groups on one row while they fit; else stacks the settings under the controls', async () => {
    // 8 buttons and 2 choices of 60px, gaps of 0 in jsdom: 600px + the divider.
    Object.assign(geometry, { toolbar: 800, item: 60 });
    await resize(800);
    expect(fixture.debugElement.children[0].componentInstance.stacked()).toBe(false);
    expect(classes(toolbar())).toEqual(expect.arrayContaining(['flex-row', 'flex-nowrap']));
    expect(classes(divider())).toEqual(expect.arrayContaining(['h-11', 'w-px']));

    Object.assign(geometry, { toolbar: 320 });
    await resize(320);
    expect(classes(toolbar())).toEqual(expect.arrayContaining(['flex-col', 'items-center']));
    expect(classes(divider())).toEqual(expect.arrayContaining(['h-px', 'w-full']));
    // Nothing hidden at 320px: every control and option is still there, and each group wraps.
    expect(buttons()).toHaveLength(8);
    expect(el.querySelectorAll('[role="radio"]')).toHaveLength(5);
    for (const box of el.querySelectorAll('[data-box]')) expect(classes(box)).toEqual(expect.arrayContaining(['flex-wrap', 'max-w-full']));

    Object.assign(geometry, { toolbar: 1200 });
    await resize(1200);
    expect(classes(toolbar())).toContain('flex-row');
  });

  it('is vertical in a rail, packing its items into columns of its height', async () => {
    host.layout.set('rail');
    await render();
    expect(toolbar().getAttribute('aria-orientation')).toBe('vertical');
    // Unmeasured: one column each.
    expect(columns('controls')).toEqual([['mic', 'cam', 'share', 'captions', 'documents', 'end']]);
    // 300px: five 44px controls and four 8px gaps (252); Video size (132) + Video fit (88) + Hide (44) = 280.
    await resize(150, 300);
    expect(columns('controls')).toEqual([['mic', 'cam', 'share', 'captions', 'documents'], ['end']]);
    expect(columns('settings')).toEqual([['Video size', 'Video fit', 'self'], ['privacy']]);
    // Labels are screen-reader only in a rail (the tooltip names the control).
    expect(control('mic').querySelector(':scope > span:last-child')?.className).toBe('sr-only');
    // 200px: four controls a column (200); a choice that doesn't fit starts the next column.
    await resize(150, 200);
    expect(columns('controls')).toEqual([['mic', 'cam', 'share', 'captions'], ['documents', 'end']]);
    expect(columns('settings')).toEqual([['Video size'], ['Video fit', 'self', 'privacy']]);
    expect(classes(divider())).toEqual(expect.arrayContaining(['w-px', 'self-stretch']));
  });

  it('in a rail, Up / Down move through every stop and Left / Right choose an option', async () => {
    host.layout.set('rail');
    await render();
    control('end').focus();
    await key(control('end'), 'ArrowDown');
    expect(document.activeElement).toBe(radio('size', 's'));
    await key(radio('size', 's'), 'ArrowRight');
    expect(host.chosen).toEqual([{ id: 'size', value: 'm' }]);
    expect(document.activeElement).toBe(radio('size', 'm'));
    await key(radio('size', 'm'), 'ArrowUp');
    expect(document.activeElement).toBe(radio('size', 's'));
  });

  it("shows a rail control's reason and tooltip beside the rail, clear of it", async () => {
    host.layout.set('rail');
    host.controls.set(BASE.map((c) => (c.id === 'cam' ? { ...c, disabled: true, reason: 'Your camera is blocked.' } : c)));
    await render();
    const tip = (control('mic').parentElement as HTMLElement).querySelector('[data-tip]') as HTMLElement;
    expect(classes(tip)).toEqual(expect.arrayContaining(['right-full', 'pr-[1.375rem]', 'top-1/2']));
    expect(classes(tip)).not.toContain('callbar:hidden!');
    control('cam').click();
    await render();
    const status = (control('cam').parentElement as HTMLElement).querySelector('[role="status"]') as HTMLElement;
    expect(status.textContent).toContain('Your camera is blocked.');
    expect(classes(status)).toEqual(expect.arrayContaining(['right-full', RAIL_GAP, 'top-1/2']));
  });

  it('disconnects its ResizeObserver when destroyed', () => {
    fixture.destroy();
    expect(FakeResizeObserver.instances.every((ro) => ro.disconnected)).toBe(true);
  });
});
