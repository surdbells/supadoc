import { Component, signal, viewChild } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '@supadoc/ui';
import { BoDialog } from './dialog';

@Component({
  imports: [BoDialog],
  template: `
    <button id="opener" type="button" (click)="open.set(true)">Open</button>
    <button id="elsewhere" type="button">Elsewhere</button>
    <bo-dialog [open]="open()" title="Suspend Dr Ada" subtitle="What happens next" [busy]="busy()" (closed)="closes = closes + 1; open.set(false)">
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
    </bo-dialog>
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly busy = signal(false);
  readonly step = signal(1);
  readonly dialog = viewChild.required(BoDialog);
  closes = 0;
}

describe('BoDialog', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const dialog = () => el.querySelector<HTMLElement>('[role="dialog"]');
  const press = async (key: string) => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
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

  afterEach(() => el.remove());

  const openFromButton = async () => {
    const opener = el.querySelector<HTMLButtonElement>('#opener');
    opener?.focus();
    opener?.click();
    await render();
    await tick();
  };

  it('renders nothing while closed', () => {
    expect(dialog()).toBeNull();
  });

  it('is a labelled, described modal dialog and moves focus to the first field', async () => {
    await openFromButton();
    const d = dialog();
    expect(d?.getAttribute('aria-modal')).toBe('true');
    expect(el.querySelector(`#${d?.getAttribute('aria-labelledby')}`)?.textContent?.trim()).toBe('Suspend Dr Ada');
    expect(el.querySelector(`#${d?.getAttribute('aria-describedby')}`)?.textContent?.trim()).toBe('What happens next');
    expect(document.activeElement?.id).toBe('reason');
  });

  it('closes on Escape and gives focus back to the button that opened it', async () => {
    await openFromButton();
    await press('Escape');
    expect(host.closes).toBe(1);
    expect(dialog()).toBeNull();
    await tick();
    expect(document.activeElement?.id).toBe('opener');
  });

  it('ignores Escape and × while busy', async () => {
    await openFromButton();
    host.busy.set(true);
    await render();
    await press('Escape');
    el.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    await render();
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
});
