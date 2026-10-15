import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { provideSupadocIcons } from '../icons/icons';
import { DialogOutletComponent } from './dialog-outlet';
import { ConfirmResult, DialogService } from './dialog.service';

@Component({
  imports: [DialogOutletComponent],
  template: `<button id="opener" type="button">Open</button><sd-dialog-outlet />`,
})
class AppRootComponent {}

@Component({ template: '' })
class PageComponent {}

describe('DialogService + <sd-dialog-outlet>', () => {
  let fixture: ComponentFixture<AppRootComponent>;
  let el: HTMLElement;
  let dialogs: DialogService;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const openDialogs = () => el.querySelectorAll('dialog');
  const button = (label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('dialog button')).find((b) => b.textContent?.trim() === label);
  const settledState = <T>(p: Promise<T>) => {
    const state: { done: boolean; value?: T } = { done: false };
    p.then((value) => {
      state.done = true;
      state.value = value;
    });
    return state;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppRootComponent],
      providers: [provideSupadocIcons(), provideRouter([{ path: 'next', component: PageComponent }])],
    }).compileComponents();
    fixture = TestBed.createComponent(AppRootComponent);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    dialogs = TestBed.inject(DialogService);
    await render();
  });

  afterEach(() => {
    fixture.destroy();
    el.remove();
  });

  it('resolves confirmed on the confirm button and closes', async () => {
    const answer = dialogs.confirm({ title: 'Approve ₦50,000 for Dr Ada?', confirmLabel: 'Approve payout' });
    await render();
    expect(openDialogs().length).toBe(1);
    expect(dialogs.hasOpen()).toBe(true);
    button('Approve payout')?.click();
    await render();
    await expect(answer).resolves.toEqual({ confirmed: true });
    expect(openDialogs().length).toBe(0);
    expect(dialogs.requests().length).toBe(0);
  });

  it('resolves not confirmed on Cancel and on Escape', async () => {
    const first = dialogs.confirm({ title: 'Close this ticket?', cancelLabel: 'Keep open' });
    await render();
    button('Keep open')?.click();
    await render();
    await expect(first).resolves.toEqual({ confirmed: false });

    const second = dialogs.confirm({ title: 'Close this ticket?' });
    await render();
    await tick();
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await render();
    await expect(second).resolves.toEqual({ confirmed: false });
  });

  it('runs the action with a spinner and resolves only after it succeeds', async () => {
    let finish!: () => void;
    const action = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const answer = settledState(
      dialogs.confirm({ title: 'Cancel this appointment?', tone: 'danger', confirmLabel: 'Cancel appointment', cancelLabel: 'Keep it', action }),
    );
    await render();
    button('Cancel appointment')?.click();
    await render();
    expect(action).toHaveBeenCalledTimes(1);
    expect(button('Cancel appointment')?.getAttribute('aria-disabled')).toBe('true');
    expect(el.querySelector('dialog')?.textContent).toContain('Working…');

    // Neither Esc nor Cancel interrupts it.
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    button('Keep it')?.click();
    await render();
    await tick();
    expect(answer.done).toBe(false);
    expect(openDialogs().length).toBe(1);

    finish();
    await tick();
    await render();
    expect(answer).toEqual({ done: true, value: { confirmed: true } });
    expect(openDialogs().length).toBe(0);
  });

  it('shows a failed action inline (apiErrorMessage), stays open and can be retried', async () => {
    const action = vi
      .fn()
      .mockReturnValueOnce(Promise.reject({ status: 422, message: 'Validation failed', errors: { reference: 'Enter the transfer reference.' } }))
      .mockReturnValueOnce(Promise.resolve());
    const answer = settledState(dialogs.confirm({ title: 'Mark as paid?', confirmLabel: 'Mark paid', action }));
    await render();
    button('Mark paid')?.click();
    await tick();
    await render();
    expect(answer.done).toBe(false);
    expect(el.querySelector('dialog [role="alert"]')?.textContent).toContain('Enter the transfer reference.');
    expect(button('Mark paid')?.getAttribute('aria-disabled')).toBeNull();

    button('Mark paid')?.click();
    await tick();
    await render();
    expect(action).toHaveBeenCalledTimes(2);
    expect(answer).toEqual({ done: true, value: { confirmed: true } });
  });

  it('accepts an Observable action and passes the validated reason to it', async () => {
    const result$ = new Subject<unknown>();
    const action = vi.fn(() => result$.asObservable());
    const answer = settledState(
      dialogs.confirm({
        title: 'Reject this payout?',
        tone: 'danger',
        confirmLabel: 'Reject payout',
        reason: { label: 'Reason', required: true, maxLength: 200 },
        action,
      }),
    );
    await render();
    await tick();
    button('Reject payout')?.click();
    await render();
    expect(action).not.toHaveBeenCalled();
    const field = el.querySelector<HTMLTextAreaElement>('dialog textarea') as HTMLTextAreaElement;
    field.value = '  Account name mismatch ';
    field.dispatchEvent(new Event('input'));
    await render();
    button('Reject payout')?.click();
    await render();
    expect(action).toHaveBeenCalledWith('Account name mismatch');
    result$.next({ ok: true });
    await tick();
    await render();
    expect(answer).toEqual({ done: true, value: { confirmed: true, reason: 'Account name mismatch' } });
  });

  it('resolves the secondary action as a choice', async () => {
    const answer = dialogs.confirm({
      title: 'End the consultation?',
      confirmLabel: 'End and complete',
      secondary: { label: 'Leave, keep it open', value: 'leave' },
    });
    await render();
    button('Leave, keep it open')?.click();
    await render();
    await expect(answer).resolves.toEqual({ confirmed: false, choice: 'leave' });
  });

  it('passes the validated reason to the secondary action and into the result', async () => {
    const action = vi.fn(() => Promise.resolve());
    const answer = dialogs.confirm({
      title: 'Decline this booking?',
      confirmLabel: 'Decline',
      reason: { label: 'Reason', required: true },
      secondary: { label: 'Suggest another time', value: 'propose', action },
    });
    await render();
    await tick();
    button('Suggest another time')?.click();
    await render();
    expect(action).not.toHaveBeenCalled();
    const field = el.querySelector<HTMLTextAreaElement>('dialog textarea') as HTMLTextAreaElement;
    field.value = ' Clinic closed that day ';
    field.dispatchEvent(new Event('input'));
    await render();
    button('Suggest another time')?.click();
    await render();
    expect(action).toHaveBeenCalledWith('Clinic closed that day');
    await expect(answer).resolves.toEqual({ confirmed: false, choice: 'propose', reason: 'Clinic closed that day' });
  });

  it('confirmLeave(): true to leave, and a newer question answers an older one with "stay"', async () => {
    const older = dialogs.confirmLeave();
    const newer = dialogs.confirmLeave({ title: 'Leave the call?', confirmLabel: 'Leave call', cancelLabel: 'Stay' });
    await expect(older).resolves.toBe(false);
    await render();
    expect(el.querySelector('dialog h2')?.textContent).toBe('Leave the call?');
    button('Leave call')?.click();
    await render();
    await expect(newer).resolves.toBe(true);
  });

  it('confirmLeave() defaults to the standard unsaved-changes copy', async () => {
    const answer = dialogs.confirmLeave();
    await render();
    expect(el.querySelector('dialog h2')?.textContent).toBe('Leave without saving?');
    button('Keep editing')?.click();
    await render();
    await expect(answer).resolves.toBe(false);
  });

  it('dismisses open prompts when a navigation starts, but not one whose action is running', async () => {
    const idle = dialogs.confirm({ title: 'Remove your photo?' });
    let finish!: () => void;
    const running = settledState(
      dialogs.confirm({ title: 'Request payout?', confirmLabel: 'Request', action: () => new Promise<void>((r) => (finish = r)) }),
    );
    await render();
    button('Request')?.click();
    await render();
    await TestBed.inject(Router).navigateByUrl('/next');
    await render();
    await expect(idle).resolves.toEqual({ confirmed: false });
    expect(running.done).toBe(false);
    finish();
    await tick();
    await render();
    expect(running).toEqual({ done: true, value: { confirmed: true } });
  });

  it('dismissAll() closes everything, running actions included', async () => {
    const answer = dialogs.confirm({ title: 'Deactivate Ada?', confirmLabel: 'Deactivate', action: () => new Promise(() => undefined) });
    await render();
    button('Deactivate')?.click();
    await render();
    dialogs.dismissAll();
    await render();
    await expect(answer).resolves.toEqual({ confirmed: false } satisfies ConfirmResult);
    expect(openDialogs().length).toBe(0);
  });
});
