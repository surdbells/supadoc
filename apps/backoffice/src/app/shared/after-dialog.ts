/**
 * Focus after a dialog's action removed the button that opened it (Approve
 * once approved, Close once closed, a Manage action once it no longer
 * applies): the dialog's own focus return finds its opener gone and focus
 * would fall to the page body, losing keyboard and screen-reader users.
 */

/**
 * Run `then` once the dialog the person is in has finished closing — its exit
 * animation and its own focus return included. "Finished" means fewer
 * `<dialog>`s are open than when this was called (a dialog stacked on another
 * one counts as closed while the one under it stays open). Gives up waiting
 * after `timeoutMs`.
 */
export function afterDialogCloses(then: () => void, doc: Document = document, timeoutMs = 3000): void {
  const openCount = (): number => doc.querySelectorAll('dialog[open]').length;
  const before = openCount();
  // The dialog's focus return is itself a timeout queued as it finishes
  // closing; queueing ours after we see it closed runs ours second.
  if (before === 0) {
    setTimeout(then);
    return;
  }
  const started = Date.now();
  const tick = (): void => {
    if (openCount() >= before && Date.now() - started < timeoutMs) {
      setTimeout(tick, 40);
      return;
    }
    setTimeout(then);
  };
  setTimeout(tick, 40);
}

/** Focus `el` unless focus is already somewhere other than the page body. */
export function focusIfLost(el: HTMLElement | null | undefined, doc: Document = document): void {
  const active = doc.activeElement;
  if (el?.isConnected && (!active || active === doc.body)) el.focus();
}
