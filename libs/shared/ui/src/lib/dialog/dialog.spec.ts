import { Component, signal, viewChild } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '../icons/icons';
import { DialogComponent } from './dialog';

@Component({
  imports: [DialogComponent],
  template: `
    <button id="opener" type="button" (click)="open.set(true)">Open</button>
    <button id="elsewhere" type="button">Elsewhere</button>
    <sd-dialog
      [open]="open()"
      title="Suspend Dr Ada"
      subtitle="What happens next"
      [busy]="busy()"
      [dismissible]="dismissible()"
      (closed)="closes = closes + 1; open.set(false)"
      (afterClose)="afterCloses = afterCloses + 1"
    >
      @if (step() === 1) {
        <label>Reason <input id="reason" /></label>
      } @else {
        <p>Done.</p>
      }
      <div dialogFooter>
        @if (step() === 1) {
          <button id="ok" type="button">OK</button>
        } @else {
          <button id="done" type="button" data-autofocus>Done</button>
        }
      </div>
    </sd-dialog>
    <sd-dialog [open]="second()" title="Second" (closed)="secondCloses = secondCloses + 1; second.set(false)">
      <button id="inner" type="button">Inner</button>
    </sd-dialog>
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly busy = signal(false);
  readonly dismissible = signal(true);
  readonly step = signal(1);
  readonly second = signal(false);
  readonly dialog = viewChild.required(DialogComponent);
  closes = 0;
  afterCloses = 0;
  secondCloses = 0;
}

/**
 * Pretend to be a browser that animates: jsdom has no WAAPI, matchMedia or
 * CSS.supports, so the dialog normally skips its exit transition here.
 */
function enableMotion(): () => void {
  const view = document.defaultView as Window & typeof globalThis;
  const animate = Element.prototype.animate;
  const matchMedia = view.matchMedia;
  const css = Object.getOwnPropertyDescriptor(view, 'CSS');
  Element.prototype.animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
  view.matchMedia = vi.fn((media: string) => ({ matches: false, media }) as unknown as MediaQueryList);
  Object.defineProperty(view, 'CSS', { configurable: true, writable: true, value: { supports: () => true } });
  return () => {
    Element.prototype.animate = animate;
    view.matchMedia = matchMedia;
    if (css) Object.defineProperty(view, 'CSS', css);
    else Reflect.deleteProperty(view, 'CSS');
  };
}

function transitionEnd(target: Element, propertyName = 'opacity'): void {
  const event = new Event('transitionend');
  Object.defineProperty(event, 'propertyName', { value: propertyName });
  target.dispatchEvent(event);
}

/** The back office's existing templates keep working through the alias. */
@Component({
  imports: [DialogComponent],
  template: `<bo-dialog [open]="true" title="Alias"><p>Body</p></bo-dialog>`,
})
class AliasHostComponent {}

describe('DialogComponent (sd-dialog)', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;
  const showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const dialog = () => el.querySelector<HTMLDialogElement>('dialog[aria-labelledby]');
  const press = async (key: string, target: Element = document.activeElement ?? document.body) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    await render();
    return event;
  };
  const openFromButton = async () => {
    const opener = el.querySelector<HTMLButtonElement>('#opener');
    opener?.focus();
    opener?.click();
    await render();
    await tick();
  };

  beforeAll(() => {
    // jsdom has <dialog> but not its modal API: stand in for the browser's.
    HTMLDialogElement.prototype.showModal = showModal;
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });

  afterAll(() => {
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  });

  beforeEach(async () => {
    showModal.mockClear();
    await TestBed.configureTestingModule({
      imports: [HostComponent, AliasHostComponent],
      providers: [provideSupadocIcons()],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
  });

  afterEach(() => {
    fixture.destroy();
    el.remove();
  });

  it('renders nothing while closed', () => {
    expect(el.querySelector('dialog')).toBeNull();
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens a labelled, described native modal and moves focus to the first field', async () => {
    await openFromButton();
    const d = dialog();
    expect(d).not.toBeNull();
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(d?.open).toBe(true);
    expect(d?.getAttribute('role')).toBe('dialog');
    expect(d?.getAttribute('aria-modal')).toBe('true');
    expect(el.querySelector(`#${d?.getAttribute('aria-labelledby')}`)?.textContent?.trim()).toBe('Suspend Dr Ada');
    expect(el.querySelector(`#${d?.getAttribute('aria-describedby')}`)?.textContent?.trim()).toBe('What happens next');
    expect(document.activeElement?.id).toBe('reason');
  });

  it('locks page scroll while open', async () => {
    await openFromButton();
    expect(document.documentElement.style.overflow).toBe('hidden');
    host.open.set(false);
    await render();
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('closes on Escape and gives focus back to the button that opened it', async () => {
    await openFromButton();
    const event = await press('Escape');
    // Handled before the browser's own close request can fire.
    expect(event.defaultPrevented).toBe(true);
    expect(host.closes).toBe(1);
    expect(dialog()).toBeNull();
    expect(host.afterCloses).toBe(1);
    await tick();
    expect(document.activeElement?.id).toBe('opener');
  });

  it('ignores Escape, the × and the native cancel request while busy', async () => {
    await openFromButton();
    host.busy.set(true);
    await render();
    expect(dialog()?.getAttribute('aria-busy')).toBe('true');
    const event = await press('Escape');
    expect(event.defaultPrevented).toBe(true);
    el.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    const cancel = new Event('cancel', { cancelable: true });
    dialog()?.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    await render();
    expect(host.closes).toBe(0);
    expect(dialog()).not.toBeNull();

    host.busy.set(false);
    await render();
    await press('Escape');
    expect(host.closes).toBe(1);
  });

  it('shows itself again when the platform closes it while busy', async () => {
    await openFromButton();
    host.busy.set(true);
    await render();
    const d = dialog() as HTMLDialogElement;
    d.removeAttribute('open');
    d.dispatchEvent(new Event('close'));
    await tick();
    await render();
    expect(host.closes).toBe(0);
    expect(showModal).toHaveBeenCalledTimes(2);
    expect(dialog()?.open).toBe(true);
  });

  it('closes on the native cancel request (e.g. Android back) when idle', async () => {
    await openFromButton();
    const cancel = new Event('cancel', { cancelable: true });
    dialog()?.dispatchEvent(cancel);
    await render();
    expect(cancel.defaultPrevented).toBe(true);
    expect(host.closes).toBe(1);
  });

  it('closes on a click on the scrim, not on a click inside the panel', async () => {
    await openFromButton();
    const d = dialog() as HTMLDialogElement;
    el.querySelector<HTMLInputElement>('#reason')?.click();
    // A press inside the panel released on the scrim (text selection) does not count.
    d.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    d.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 500, clientY: 500 }));
    await render();
    expect(host.closes).toBe(0);
    d.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 500, clientY: 500 }));
    d.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 500, clientY: 500 }));
    await render();
    expect(host.closes).toBe(1);
  });

  it('cannot be dismissed at all when not dismissible (no ×)', async () => {
    host.dismissible.set(false);
    await openFromButton();
    expect(el.querySelector('button[aria-label="Close"]')).toBeNull();
    await press('Escape');
    expect(host.closes).toBe(0);
    expect(dialog()).not.toBeNull();
  });

  it('still closes on Escape after the focused control was removed', async () => {
    await openFromButton();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await press('Escape');
    expect(host.closes).toBe(1);
  });

  it('brings Tab back into the dialog when focus fell to the page', async () => {
    await openFromButton();
    (document.activeElement as HTMLElement | null)?.blur();
    await press('Tab');
    expect(dialog()?.contains(document.activeElement)).toBe(true);
  });

  it('only the topmost dialog answers Escape', async () => {
    await openFromButton();
    host.second.set(true);
    await render();
    await tick();
    expect(document.activeElement?.id).not.toBe('reason');
    await press('Escape', document.body);
    expect(host.secondCloses).toBe(1);
    expect(host.closes).toBe(0);
    await press('Escape', document.body);
    expect(host.closes).toBe(1);
  });

  it("refocus() moves focus to the new step's autofocus control", async () => {
    await openFromButton();
    host.step.set(2);
    await render();
    expect(document.activeElement).toBe(document.body);
    host.dialog().refocus();
    await render();
    expect(document.activeElement?.id).toBe('done');
  });

  it('does not take focus back from where the closing action sent it', async () => {
    await openFromButton();
    el.querySelector<HTMLButtonElement>('#elsewhere')?.focus();
    host.open.set(false);
    await render();
    await tick();
    expect(document.activeElement?.id).toBe('elsewhere');
  });

  it('keeps a static title off the host element (no tooltip over the dialog)', async () => {
    await openFromButton();
    expect(el.querySelector('sd-dialog')?.hasAttribute('title')).toBe(false);
    expect(dialog()?.textContent).toContain('Suspend Dr Ada');
  });

  describe('animated exit', () => {
    let restoreMotion: () => void;
    beforeEach(() => (restoreMotion = enableMotion()));
    afterEach(() => restoreMotion());

    it('closes natively the moment it starts closing, then fades out inert and reports afterClose', async () => {
      await openFromButton();
      const d = dialog() as HTMLDialogElement;
      host.open.set(false);
      await render();
      // Native close first: the page behind is interactive again during the fade.
      expect(d.open).toBe(false);
      expect(d.isConnected).toBe(true);
      expect(d.hasAttribute('inert')).toBe(true);
      expect(d.classList.contains('sd-dialog--leaving')).toBe(true);
      expect(d.getAttribute('data-state')).toBe('closing');
      expect(host.afterCloses).toBe(0);

      transitionEnd(d, 'transform'); // only the opacity transition ends it
      await render();
      expect(dialog()).not.toBeNull();
      transitionEnd(d);
      await render();
      expect(dialog()).toBeNull();
      expect(host.afterCloses).toBe(1);
      expect(document.documentElement.style.overflow).toBe('');
    });

    it('focus moved by the closing action sticks; otherwise it goes back to the opener', async () => {
      await openFromButton();
      const elsewhere = el.querySelector<HTMLButtonElement>('#elsewhere') as HTMLButtonElement;
      // The handler that closes it schedules a focus move (before change detection runs).
      setTimeout(() => elsewhere.focus());
      host.open.set(false);
      await render();
      await tick();
      expect(document.activeElement).toBe(elsewhere);

      await openFromButton();
      expect(document.activeElement?.id).toBe('reason');
      host.open.set(false);
      await render();
      await tick();
      // Still mid-fade, focus is already back on the opener (not left in the inert dialog).
      expect(dialog()).not.toBeNull();
      expect(document.activeElement?.id).toBe('opener');
    });

    it('can be opened again while it animates out', async () => {
      await openFromButton();
      const d = dialog() as HTMLDialogElement;
      host.open.set(false);
      await render();
      host.open.set(true);
      await render();
      await tick();
      expect(dialog()).toBe(d);
      expect(d.open).toBe(true);
      expect(d.hasAttribute('inert')).toBe(false);
      expect(d.classList.contains('sd-dialog--leaving')).toBe(false);
      expect(document.activeElement?.id).toBe('reason');
      transitionEnd(d); // a stale end of the cancelled exit
      await render();
      expect(dialog()).toBe(d);
      expect(host.afterCloses).toBe(0);
    });

    it('still finishes when the transition never ends (hidden tab)', async () => {
      await openFromButton();
      host.open.set(false);
      await render();
      expect(dialog()).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await render();
      expect(dialog()).toBeNull();
      expect(host.afterCloses).toBe(1);
    });
  });

  it('releases the scroll lock when destroyed while open', async () => {
    await openFromButton();
    fixture.destroy();
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('answers to the bo-dialog alias', async () => {
    const alias = TestBed.createComponent(AliasHostComponent);
    alias.detectChanges();
    await alias.whenStable();
    alias.detectChanges();
    const d = (alias.nativeElement as HTMLElement).querySelector('dialog');
    expect(d?.getAttribute('role')).toBe('dialog');
    expect(d?.textContent).toContain('Alias');
    alias.destroy();
  });

  it('takes an exact max width instead of a size class', async () => {
    const custom = TestBed.createComponent(MaxWidthHostComponent);
    custom.detectChanges();
    await custom.whenStable();
    custom.detectChanges();
    const d = (custom.nativeElement as HTMLElement).querySelector<HTMLDialogElement>('dialog');
    expect(d?.classList.contains('sd-dialog--custom')).toBe(true);
    expect(d?.classList.contains('sd-dialog--md')).toBe(false);
    expect(d?.style.getPropertyValue('--sd-dialog-max')).toBe('470px');
    custom.componentInstance.width.set(null);
    custom.detectChanges();
    expect(d?.classList.contains('sd-dialog--custom')).toBe(false);
    expect(d?.classList.contains('sd-dialog--md')).toBe(true);
    custom.destroy();
  });
});

@Component({
  imports: [DialogComponent],
  template: `<sd-dialog [open]="true" title="Custom" [maxWidth]="width()"><p>Body</p></sd-dialog>`,
})
class MaxWidthHostComponent {
  readonly width = signal<number | null>(470);
}
