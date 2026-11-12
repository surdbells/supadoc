import { afterDialogCloses, focusIfLost } from './after-dialog';

describe('after-dialog', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    root.innerHTML = `
      <button id="target" type="button">Target</button>
      <button id="other" type="button">Other</button>
      <dialog id="under" open></dialog>
      <dialog id="top" open></dialog>
    `;
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    vi.useRealTimers();
  });

  // Fake timers (Date too): the 40 ms polls and the give-up time are counted, not raced against a
  // busy machine's clock.
  it('waits until the dialog the person is in has closed (one under it may stay open)', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    afterDialogCloses(() => calls.push('done'));
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual([]);
    root.querySelector('#top')?.removeAttribute('open');
    vi.advanceTimersByTime(39);
    expect(calls).toEqual([]);
    // The next poll sees it closed, and queues the callback behind the dialog's own focus return.
    vi.advanceTimersByTime(2);
    expect(calls).toEqual(['done']);
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual(['done']);
  });

  it('gives up waiting after timeoutMs', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    afterDialogCloses(() => calls.push('done'), document, 500);
    vi.advanceTimersByTime(480);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(42);
    expect(calls).toEqual(['done']);
  });

  it('runs straight away (after a tick) when no dialog is open', () => {
    vi.useFakeTimers();
    root.querySelectorAll('dialog').forEach((d) => d.removeAttribute('open'));
    const calls: string[] = [];
    afterDialogCloses(() => calls.push('done'));
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(0);
    expect(calls).toEqual(['done']);
  });

  it('only takes focus back from the page body', () => {
    const target = root.querySelector<HTMLButtonElement>('#target');
    const other = root.querySelector<HTMLButtonElement>('#other');
    other?.focus();
    focusIfLost(target);
    expect(document.activeElement).toBe(other);
    other?.blur();
    focusIfLost(target);
    expect(document.activeElement).toBe(target);
  });
});
