import { afterDialogCloses, focusIfLost } from './after-dialog';

describe('after-dialog', () => {
  let root: HTMLElement;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  afterEach(() => root.remove());

  it('waits until the dialog the person is in has closed (one under it may stay open)', async () => {
    const calls: string[] = [];
    afterDialogCloses(() => calls.push('done'));
    await wait(100);
    expect(calls).toEqual([]);
    root.querySelector('#top')?.removeAttribute('open');
    await wait(100);
    expect(calls).toEqual(['done']);
  });

  it('runs straight away (after a tick) when no dialog is open', async () => {
    root.querySelectorAll('dialog').forEach((d) => d.removeAttribute('open'));
    const calls: string[] = [];
    afterDialogCloses(() => calls.push('done'));
    expect(calls).toEqual([]);
    await wait(0);
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
