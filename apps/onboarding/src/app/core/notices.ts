import { Injectable, signal } from '@angular/core';

/**
 * Where a one-off message is shown after a redirect. `status` is a success
 * message on the status page; `status-info` tells the applicant their
 * application moved on while a page was open (a 409 from the server).
 */
export type NoticeSlot = 'landing' | 'resume' | 'track' | 'status' | 'status-info';

export const NOTICE = {
  cancelled: 'Your application was cancelled and its details deleted.',
  sessionEnded: 'Your session has ended. Resume with the link or code we emailed you.',
  trackExpired: 'This check has timed out. Start again.',
  reviewResumed: 'Thanks — your review has resumed.',
  trackSessionEnded: 'Your session has ended. Check your status again.',
} as const;

/**
 * One-off messages carried across a navigation (memory only): set before
 * redirecting, taken (and cleared) by the page or modal that shows them.
 */
@Injectable({ providedIn: 'root' })
export class Notices {
  private readonly slots = signal<Partial<Record<NoticeSlot, string>>>({});

  set(slot: NoticeSlot, message: string): void {
    this.slots.update((s) => ({ ...s, [slot]: message }));
  }

  /** The message for `slot`, cleared once read. */
  take(slot: NoticeSlot): string | null {
    const message = this.slots()[slot] ?? null;
    if (message !== null) this.slots.update((s) => ({ ...s, [slot]: undefined }));
    return message;
  }

  peek(slot: NoticeSlot): string | null {
    return this.slots()[slot] ?? null;
  }
}
