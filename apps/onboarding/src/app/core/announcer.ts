import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';

/** Id of the polite live region in app.html. */
export const ANNOUNCER_ID = 'onb-announcer';

/**
 * Speaks short status messages through the app's polite live region
 * (`#onb-announcer`): step changes, "Reference copied", "Code expired"… The
 * text is cleared first so repeating the same message is announced again.
 */
@Injectable({ providedIn: 'root' })
export class Announcer {
  private readonly doc = inject(DOCUMENT);
  private timer: ReturnType<typeof setTimeout> | null = null;

  announce(message: string): void {
    const region = this.doc.getElementById(ANNOUNCER_ID);
    if (!region) return;
    region.textContent = '';
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      region.textContent = message;
      this.timer = null;
    }, 60);
  }
}
