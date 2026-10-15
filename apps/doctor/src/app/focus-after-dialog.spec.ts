import { Component, inject, Injector } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DialogOutletComponent, DialogService, provideSupadocIcons } from '@supadoc/ui';
import { focusAfterDialogs } from './focus-after-dialog';

@Component({
  imports: [DialogOutletComponent],
  template: `
    <button id="opener" type="button">Delete draft</button>
    <p id="note" tabindex="-1">Draft deleted.</p>
    <sd-dialog-outlet />
  `,
})
class HostComponent {
  readonly injector = inject(Injector);
}

describe('focusAfterDialogs', () => {
  let fixture: ComponentFixture<HostComponent>;
  let el: HTMLElement;
  let dialogs: DialogService;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await render();
      await tick();
    }
  };
  const button = (label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('dialog button')).find((b) => b.textContent?.trim() === label);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideSupadocIcons(), provideRouter([])],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    dialogs = TestBed.inject(DialogService);
    await render();
  });

  afterEach(() => {
    fixture.destroy();
    el.remove();
  });

  it('focuses the status message once the prompt is gone, after its opener was removed', async () => {
    el.querySelector<HTMLButtonElement>('#opener')?.focus();
    const answer = dialogs.confirm({ title: 'Delete this draft?', confirmLabel: 'Delete draft', cancelLabel: 'Keep it' });
    await settle();

    button('Delete draft')?.click();
    await expect(answer).resolves.toEqual({ confirmed: true });
    // What the page does on success: the row (and its button) goes, focus is sent to the notice.
    el.querySelector('#opener')?.remove();
    focusAfterDialogs(fixture.componentInstance.injector, () => el.querySelector<HTMLElement>('#note'));
    await settle();

    expect(dialogs.requests().length).toBe(0);
    expect(document.activeElement?.id).toBe('note');
  });

  it('waits while a prompt is still open', async () => {
    const answer = dialogs.confirm({ title: 'Remove this time?', confirmLabel: 'Remove time', cancelLabel: 'Keep it' });
    await settle();
    focusAfterDialogs(fixture.componentInstance.injector, () => el.querySelector<HTMLElement>('#note'));
    await settle();
    expect(document.activeElement?.id).not.toBe('note');

    button('Keep it')?.click();
    await answer;
    await settle();
    expect(document.activeElement?.id).toBe('note');
  });
});
