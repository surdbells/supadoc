import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '../icons/icons';
import {
  ConfirmChoice,
  ConfirmDialogComponent,
  ConfirmReasonOptions,
  ConfirmSecondaryAction,
  ConfirmTone,
} from './confirm-dialog';

@Component({
  imports: [ConfirmDialogComponent],
  template: `
    <button id="opener" type="button" (click)="open.set(true)">Open</button>
    <!-- The pre-v2 API, exactly as the shells and the Rx screens bind it. -->
    <sd-confirm-dialog
      [open]="open()"
      title="Reject Dr Ada's ₦50,000 payout?"
      message="They're emailed and can request again."
      confirmLabel="Reject payout"
      cancelLabel="Keep it"
      icon="ban"
      [danger]="danger()"
      [tone]="tone()"
      [details]="[{ label: 'Amount', value: '₦50,000' }, { label: 'Account', value: 'GTBank ••1234' }]"
      [reason]="reason()"
      [secondary]="secondary()"
      [busy]="busy()"
      [error]="error()"
      (confirm)="confirmed.push($event); open.set(false)"
      (cancel)="cancels = cancels + 1; open.set(false)"
      (choice)="choices.push($event)"
    />
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly danger = signal(true);
  readonly tone = signal<ConfirmTone | undefined>(undefined);
  readonly reason = signal<ConfirmReasonOptions | null>(null);
  readonly secondary = signal<ConfirmSecondaryAction | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly confirmed: (string | undefined)[] = [];
  readonly choices: ConfirmChoice[] = [];
  cancels = 0;
}

describe('ConfirmDialogComponent (sd-confirm-dialog v2)', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const dialog = () => el.querySelector<HTMLDialogElement>('dialog');
  const button = (label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('dialog button')).find((b) => b.textContent?.trim() === label);
  const textarea = () => el.querySelector<HTMLTextAreaElement>('dialog textarea');
  const type = async (value: string) => {
    const field = textarea() as HTMLTextAreaElement;
    field.value = value;
    field.dispatchEvent(new Event('input'));
    await render();
  };
  const show = async () => {
    const opener = el.querySelector<HTMLButtonElement>('#opener');
    opener?.focus();
    host.open.set(true);
    await render();
    await tick();
  };
  const escape = async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await render();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
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

  it('keeps the v1 API: [danger] → an alertdialog that focuses the safe action', async () => {
    await show();
    const d = dialog();
    expect(d?.getAttribute('role')).toBe('alertdialog');
    expect(el.querySelector(`#${d?.getAttribute('aria-labelledby')}`)?.textContent).toContain('Reject Dr Ada');
    expect(el.querySelector(`#${d?.getAttribute('aria-describedby')}`)?.textContent).toContain("They're emailed");
    expect(document.activeElement).toBe(button('Keep it'));
    button('Reject payout')?.click();
    await render();
    expect(host.confirmed).toEqual([undefined]);
    expect(dialog()).toBeNull();
  });

  it('is a plain dialog that focuses the confirm button for info prompts', async () => {
    host.danger.set(false);
    host.tone.set('info');
    await show();
    expect(dialog()?.getAttribute('role')).toBe('dialog');
    expect(document.activeElement).toBe(button('Reject payout'));
  });

  it('shows the details list', async () => {
    await show();
    const rows = Array.from(el.querySelectorAll('dialog dl > div')).map(
      (r) => `${r.querySelector('dt')?.textContent?.trim()} ${r.querySelector('dd')?.textContent?.trim()}`,
    );
    expect(rows).toEqual(['Amount ₦50,000', 'Account GTBank ••1234']);
  });

  it('emits cancel on Cancel and on Escape', async () => {
    await show();
    button('Keep it')?.click();
    await render();
    expect(host.cancels).toBe(1);
    await show();
    await escape();
    expect(host.cancels).toBe(2);
  });

  it('validates a required reason before confirming, then emits it trimmed', async () => {
    host.reason.set({ label: 'Reason for rejecting', required: true, minLength: 5, maxLength: 200 });
    await show();
    const field = textarea() as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('aria-required')).toBe('true');
    expect(field.getAttribute('maxlength')).toBe('200');

    button('Reject payout')?.click();
    await render();
    expect(host.confirmed).toEqual([]);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const errorId = field.getAttribute('aria-describedby')?.split(' ')[0] ?? '';
    expect(el.querySelector(`#${errorId}`)?.textContent).toContain('Reason for rejecting is required.');

    await type('abc');
    expect(el.querySelector(`#${errorId}`)?.textContent).toContain('at least 5 characters');
    button('Reject payout')?.click();
    await render();
    expect(host.confirmed).toEqual([]);

    await type('  Bank details do not match  ');
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(el.textContent).toContain('29/200');
    button('Reject payout')?.click();
    await render();
    expect(host.confirmed).toEqual(['Bank details do not match']);
  });

  it('accepts an empty optional reason and starts fresh on every opening', async () => {
    host.reason.set({ label: 'Message to the patient', maxLength: 300 });
    await show();
    expect(el.textContent).toContain('(optional)');
    await type('See you soon');
    button('Keep it')?.click();
    await render();
    await show();
    expect(textarea()?.value).toBe('');
    button('Reject payout')?.click();
    await render();
    expect(host.confirmed).toEqual([undefined]);
  });

  it('while busy: spinner, no clicks, no Escape; then shows the error inline', async () => {
    await show();
    host.busy.set(true);
    await render();
    const confirm = button('Reject payout') as HTMLButtonElement;
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(confirm.querySelector('sd-icon')).not.toBeNull();
    confirm.click();
    button('Keep it')?.click();
    await escape();
    expect(host.confirmed).toEqual([]);
    expect(host.cancels).toBe(0);
    expect(dialog()).not.toBeNull();

    host.busy.set(false);
    host.error.set('The payout was already settled.');
    await render();
    expect(el.querySelector('dialog [role="alert"]')?.textContent).toContain('The payout was already settled.');
  });

  it('offers a secondary action', async () => {
    host.secondary.set({ label: 'Hold for review', value: 'hold' });
    await show();
    button('Hold for review')?.click();
    await render();
    expect(host.choices).toEqual([{ value: 'hold' }]);
  });

  it('validates the reason for the secondary action too and passes it on', async () => {
    host.reason.set({ label: 'Reason', required: true, minLength: 5 });
    host.secondary.set({ label: 'Hold for review', value: 'hold' });
    await show();
    button('Hold for review')?.click();
    await render();
    expect(host.choices).toEqual([]);
    expect(textarea()?.getAttribute('aria-invalid')).toBe('true');
    await type('  Needs a second look ');
    button('Hold for review')?.click();
    await render();
    expect(host.choices).toEqual([{ value: 'hold', reason: 'Needs a second look' }]);
  });

  it('a secondary action with ignoreReason skips the reason field', async () => {
    host.reason.set({ label: 'Reason', required: true });
    host.secondary.set({ label: 'Hold for review', value: 'hold', ignoreReason: true });
    await show();
    await type('Typed but not for this');
    button('Hold for review')?.click();
    await render();
    expect(host.choices).toEqual([{ value: 'hold' }]);
  });

  it('keeps a static title off the host element (no tooltip over the dialog)', async () => {
    await show();
    expect(el.querySelector('sd-confirm-dialog')?.hasAttribute('title')).toBe(false);
  });

  it('ignores its buttons once closed, while it animates out (no double confirm)', async () => {
    const view = document.defaultView as Window & typeof globalThis;
    const animate = Element.prototype.animate;
    const matchMedia = view.matchMedia;
    const css = Object.getOwnPropertyDescriptor(view, 'CSS');
    Element.prototype.animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
    view.matchMedia = vi.fn((media: string) => ({ matches: false, media }) as unknown as MediaQueryList);
    Object.defineProperty(view, 'CSS', { configurable: true, writable: true, value: { supports: () => true } });
    try {
      host.secondary.set({ label: 'Hold for review', value: 'hold' });
      await show();
      const confirm = button('Reject payout') as HTMLButtonElement;
      confirm.click();
      await render();
      // The v1 caller closed it in (confirm); the panel is still fading out.
      expect(dialog()).not.toBeNull();
      expect(dialog()?.hasAttribute('inert')).toBe(true);
      confirm.click();
      button('Hold for review')?.click();
      button('Keep it')?.click();
      await render();
      expect(host.confirmed).toEqual([undefined]);
      expect(host.choices).toEqual([]);
      expect(host.cancels).toBe(0);
    } finally {
      Element.prototype.animate = animate;
      view.matchMedia = matchMedia;
      if (css) Object.defineProperty(view, 'CSS', css);
      else Reflect.deleteProperty(view, 'CSS');
    }
  });
});
