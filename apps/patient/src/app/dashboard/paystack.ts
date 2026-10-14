/**
 * Paystack Inline v2 — the card pop-up used by booking and by accepting a
 * follow-up. The script is loaded once, on first use, and shared by every page.
 */

/** Minimal shape of Paystack Inline v2 used here (not shipped with types). */
export interface PaystackTxnCallbacks {
  onSuccess?: (transaction: { reference?: string }) => void;
  onCancel?: () => void;
  onError?: (error: unknown) => void;
}
export interface PaystackPopInstance {
  resumeTransaction(accessCode: string, callbacks?: PaystackTxnCallbacks): void;
}
export type PaystackPopCtor = new () => PaystackPopInstance;

let loader: Promise<PaystackPopCtor> | undefined;

/** Lazy-load Paystack's inline v2 script once and resolve its constructor. */
export function loadPaystack(): Promise<PaystackPopCtor> {
  loader ??= new Promise<PaystackPopCtor>((resolve, reject) => {
    const existing = (window as unknown as { PaystackPop?: PaystackPopCtor }).PaystackPop;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://js.paystack.co/v2/inline.js';
    script.async = true;
    // A failed load isn't cached, so a later attempt can succeed (e.g. back online).
    const fail = (): void => {
      loader = undefined;
      script.remove();
      reject(new Error('Paystack failed to load'));
    };
    script.onload = () => {
      const ctor = (window as unknown as { PaystackPop?: PaystackPopCtor }).PaystackPop;
      if (ctor) resolve(ctor);
      else fail();
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return loader;
}
