/**
 * Class strings shared by the onboarding forms. Tailwind sees them here, so
 * keep every class literal (no string building of class names).
 */

/** A 48px text control (radius 16, 14px text); add `border-ash` or `border-alert`. */
export const ONB_CONTROL =
  'h-12 w-full rounded-field border bg-white px-4 font-sans text-body-sm text-ink placeholder:text-slate ' +
  'focus:outline-none focus:border-cerulean focus:ring-2 focus:ring-cerulean/20';

/** The bio textarea: the control without its fixed height. */
export const ONB_TEXTAREA =
  'min-h-[115px] w-full resize-y rounded-field border bg-white px-4 py-3 font-sans text-body-sm text-ink ' +
  'placeholder:text-slate focus:outline-none focus:border-cerulean focus:ring-2 focus:ring-cerulean/20';

/** ONB_CONTROL with its border colour. */
export function onbControl(invalid: boolean): string {
  return `${ONB_CONTROL} ${invalid ? 'border-alert' : 'border-ash'}`;
}

export function onbTextarea(invalid: boolean): string {
  return `${ONB_TEXTAREA} ${invalid ? 'border-alert' : 'border-ash'}`;
}

/** sd-button's base and `md` size, without its `disabled:` utilities (spec D29). */
const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-field font-sans font-semibold tracking-[0.48px] ' +
  'select-none transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-cerulean/40 focus-visible:ring-offset-2 px-4 py-3 text-[16px] leading-6';

const PRESS = 'motion-safe:active:scale-[0.97] active:duration-75';

export type OnbButtonVariant = 'primary' | 'danger' | 'outlineAlert' | 'neutral';

/**
 * Native-button classes with the Figma "disabled" look that stays focusable and
 * clickable (D29): set `aria-disabled="true"` while `inert`, and on click show
 * what is missing instead of acting.
 */
export const ONB_BUTTON: Record<OnbButtonVariant | 'primaryInert' | 'dangerInert', string> = {
  primary: `${BUTTON_BASE} ${PRESS} bg-cerulean text-white shadow-btn inset-shadow-rim hover:bg-cerulean-dark hover:shadow-btn-hover`,
  primaryInert: `${BUTTON_BASE} cursor-not-allowed bg-cerulean/30 text-white shadow-none`,
  danger: `${BUTTON_BASE} ${PRESS} bg-alert text-white shadow-[0_2px_10px_rgba(229,57,53,0.25)] inset-shadow-rim hover:brightness-95`,
  dangerInert: `${BUTTON_BASE} cursor-not-allowed bg-alert/30 text-white shadow-none`,
  outlineAlert: `${BUTTON_BASE} ${PRESS} bg-white text-alert ring-1 ring-inset ring-alert hover:bg-alert/5`,
  neutral: `${BUTTON_BASE} ${PRESS} bg-white text-slate ring-1 ring-inset ring-ash hover:bg-glacier`,
};

export function onbButton(variant: OnbButtonVariant, inert = false): string {
  if (inert && variant === 'primary') return ONB_BUTTON.primaryInert;
  if (inert && variant === 'danger') return ONB_BUTTON.dangerInert;
  return ONB_BUTTON[variant];
}

/**
 * The status page's small pill buttons (28px tall, 12px text). An invisible
 * `before:` layer lifts the hit area to 40px without changing the look.
 */
export const ONB_PILL = {
  primary:
    "relative inline-flex h-7 items-center gap-1.5 rounded-pill bg-cerulean px-3 font-sans text-caption font-medium text-white transition-colors hover:bg-cerulean-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2 before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']",
  neutral:
    "relative inline-flex h-7 items-center gap-1.5 rounded-pill bg-white px-3 font-sans text-caption font-medium text-slate ring-1 ring-inset ring-ash transition-colors hover:bg-glacier focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2 before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']",
} as const;

/** Text-only link-style button (Cerulean, medium). */
export const ONB_TEXT_BUTTON =
  'inline-flex items-center gap-2 rounded-md font-sans font-medium text-cerulean transition-colors hover:text-cerulean-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40';

/** The modals' 40px buttons (13px Medium, Figma 247×40). Same D29 inert look. */
const MODAL_BASE =
  'inline-flex h-10 items-center justify-center gap-2 rounded-field px-4 font-sans text-[13px] font-medium ' +
  'tracking-[0.03em] select-none transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-cerulean/40 focus-visible:ring-offset-2';

const MODAL_BUTTON: Record<OnbButtonVariant | 'primaryInert' | 'dangerInert', string> = {
  primary: `${MODAL_BASE} ${PRESS} bg-cerulean text-white shadow-btn hover:bg-cerulean-dark`,
  primaryInert: `${MODAL_BASE} cursor-not-allowed bg-cerulean/30 text-white`,
  danger: `${MODAL_BASE} ${PRESS} bg-alert text-white hover:brightness-95`,
  dangerInert: `${MODAL_BASE} cursor-not-allowed bg-alert/30 text-white`,
  outlineAlert: `${MODAL_BASE} ${PRESS} bg-white text-alert ring-1 ring-inset ring-alert hover:bg-alert/5`,
  neutral: `${MODAL_BASE} ${PRESS} bg-white text-slate ring-1 ring-inset ring-ash hover:bg-glacier`,
};

export function onbModalButton(variant: OnbButtonVariant, inert = false): string {
  if (inert && variant === 'primary') return MODAL_BUTTON.primaryInert;
  if (inert && variant === 'danger') return MODAL_BUTTON.dangerInert;
  return MODAL_BUTTON[variant];
}

/** Widths of primary buttons from the Figma (desktop); full width below 900px. */
export const ONB_WIDTH: Record<number, string> = {
  200: 'w-full min-[900px]:w-[200px]',
  250: 'w-full min-[900px]:w-[250px]',
  311: 'w-full min-[900px]:w-[311px]',
  323: 'w-full min-[900px]:w-[323px]',
};
