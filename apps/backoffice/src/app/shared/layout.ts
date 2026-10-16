/**
 * Back-office layout tokens — the doctor portal's Figma-parity spacing system
 * (doctor `dashboard.ts`, `patients/patients.ts`, `appointment/clinical/clinical-ui.ts`),
 * so the console reads like the doctor and patient portals.
 *
 * Every value is a complete, literal class string: Tailwind v4 finds classes by
 * scanning source text, so never assemble one from pieces (`'p-' + n`).
 * The one elevation used throughout is `shadow-[0_1px_2px_rgba(10,22,40,0.04)]`.
 */

export const FOCUS_RING = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40';

// ----- Page -----

/** Every page's wrapper. */
export const PAGE = 'flex flex-col gap-6 py-2';
/** Settings-type pages: one readable column. */
export const PAGE_NARROW = 'flex w-full max-w-3xl flex-col gap-6 py-2';
/** Create flows (new appointment). */
export const PAGE_FORM = 'flex w-full max-w-4xl flex-col gap-6 py-2';
/** Title block on the left, actions on the right. */
export const PAGE_HEADER = 'flex flex-wrap items-start justify-between gap-4';
/** Detail pages: title on the left, "‹ Back" on the right. */
export const PAGE_HEADER_DETAIL = 'flex flex-wrap items-center justify-between gap-4';
export const PAGE_HEADER_TEXT = 'flex min-w-0 flex-col gap-1';
/** The h1 and its count badge. */
export const PAGE_TITLE_ROW = 'flex flex-wrap items-center gap-3';
export const PAGE_TITLE = 'font-heading text-h3 text-ink';
export const PAGE_SUBTITLE = 'font-sans text-body text-slate';
/** "12 patients" beside the h1 (+ a 14px icon). */
export const COUNT_BADGE =
  'inline-flex items-center gap-1.5 rounded-pill bg-cerulean/10 px-3 py-1 font-sans text-caption font-semibold text-cerulean';
/** Detail pages' Back link, right of the h1 (+ `chevron-right` 18, rotated 180°). */
export const BACK_LINK =
  'flex min-h-11 shrink-0 items-center gap-1 rounded-field font-sans text-body text-slate transition-colors hover:text-cerulean ' +
  FOCUS_RING;
/** Create flows' back link, above the header (+ `chevron-right` 16, rotated 180°). */
export const BACK_LINK_ABOVE =
  'flex min-h-11 w-fit items-center gap-1 rounded-field font-sans text-body-sm text-slate transition-colors hover:text-cerulean ' +
  FOCUS_RING;
/** Actions in a page header. */
export const HEADER_ACTIONS = 'flex flex-wrap items-center gap-3';

// ----- Cards & sections -----

export const CARD = 'rounded-card border border-cloud bg-white';
export const CARD_RAISED = 'rounded-card border border-cloud bg-white shadow-[0_1px_2px_rgba(10,22,40,0.04)]';
/** A content card with its own padding. */
export const SECTION =
  'flex min-w-0 flex-col gap-5 rounded-card border border-cloud bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)] sm:p-6';
/** A smaller side card (summaries, checklists). */
export const SECTION_SM =
  'flex min-w-0 flex-col gap-4 rounded-card border border-cloud bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)]';
/** A section's h2 (+ a 20px `text-cerulean` icon). Weight 500 comes from the token. */
export const SECTION_TITLE = 'flex items-center gap-2 font-heading text-body-lg text-ink';
export const SECTION_SUBTITLE = 'font-sans text-body-sm text-slate';
export const SECTION_HEAD = 'flex flex-wrap items-start justify-between gap-3';
/** A sub-heading inside a card (h3). */
export const SUBSECTION_TITLE = 'flex items-center gap-2 font-heading text-body font-semibold text-ink';
/** A count next to a heading. */
export const COUNT_PILL = 'rounded-pill bg-cloud px-2.5 py-0.5 font-sans text-caption font-semibold text-slate';
export const SECTION_GRID = 'grid gap-6 lg:grid-cols-2';
/** A card with a header bar, divided rows and a footer link (doctor "Today's Schedule"). */
export const LIST_CARD = 'flex min-w-0 flex-col rounded-card border border-cloud bg-white shadow-[0_1px_2px_rgba(10,22,40,0.04)]';
export const LIST_CARD_HEAD = 'flex flex-wrap items-center justify-between gap-2 border-b border-cloud px-5 py-4';
export const LIST_CARD_BODY = 'flex flex-col divide-y divide-cloud';
export const LIST_CARD_ROW = 'flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3.5';
export const LIST_CARD_FOOT =
  'mt-auto flex min-h-11 items-center justify-center gap-1 border-t border-cloud px-5 py-3.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:bg-frost/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cerulean/40';
/** Empty body of a list card (+ a 28px slate icon and a body-sm slate line). */
export const LIST_CARD_EMPTY = 'flex flex-1 flex-col items-center justify-center gap-2 px-5 py-12 text-center';
/** The record header card on detail pages. */
export const DETAIL_HEADER =
  'grid gap-6 rounded-card border border-cloud bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)] sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto]';
export const DETAIL_AVATAR =
  'flex size-20 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h4 text-cerulean sm:size-24 sm:text-h3';
export const DETAIL_NAME = 'break-words font-heading text-h4 text-ink';
/** The header card's quick-actions column. */
export const DETAIL_ACTIONS =
  'flex w-full flex-col gap-3 border-t border-cloud pt-5 lg:w-64 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0';
/** A labelled fact tile (email / phone / date of birth). */
export const INFO_TILES = 'flex flex-wrap gap-3';
export const INFO_TILE = 'flex min-w-0 flex-[1_1_auto] flex-col gap-1 rounded-field border border-cloud px-4 py-3';
export const INFO_TILE_LABEL = 'flex items-center gap-1.5 font-sans text-caption text-slate';
export const INFO_TILE_VALUE = 'break-words font-sans text-body-sm text-ink';
/** A page-level load error (+ `wifi-off` 32 alert and a body-sm slate line). */
export const PAGE_ERROR = 'flex flex-col items-center gap-3 rounded-card border border-cloud bg-white px-5 py-16 text-center';
/** A compact error / empty card inside a tab or section (+ a 28px icon, a body-sm line, an optional button). */
export const PANEL_STATE =
  'flex flex-col items-center justify-center gap-3 rounded-card border border-cloud bg-white px-5 py-12 text-center shadow-[0_1px_2px_rgba(10,22,40,0.04)]';
/** A card that frames an `sd-empty-state`. */
export const EMPTY_FRAME = 'rounded-card border border-cloud bg-white px-4';
/** An inline error under a list (+ `circle-alert` 16). */
export const INLINE_ERROR = 'flex items-center gap-2 rounded-field bg-alert/10 px-4 py-2.5 font-sans text-caption text-alert';
/** "Showing x of y" + Load more. */
export const LOAD_MORE = 'flex flex-col items-center gap-3';
export const LOAD_MORE_NOTE = 'font-sans text-caption text-slate';

// ----- Notices (rows that need attention) -----

export const NOTICE =
  'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border px-5 py-4 transition-colors ' + FOCUS_RING;
export const NOTICE_TONE = {
  warning: { card: 'border-warning/30 bg-warning/5 hover:bg-warning/10', accent: 'text-warning' },
  alert: { card: 'border-alert/30 bg-alert/5 hover:bg-alert/10', accent: 'text-alert' },
  info: { card: 'border-cerulean/20 bg-frost/50 hover:bg-frost', accent: 'text-cerulean' },
} as const;
export const NOTICE_ICON = 'flex size-10 shrink-0 items-center justify-center rounded-full bg-white shadow-sm';

// ----- Stat tiles (doctor dashboard) -----

export const STAT_GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5';
export const STAT_GRID_4 = 'grid grid-cols-2 gap-3 lg:grid-cols-4';
export const STAT_TILE =
  'flex min-w-0 flex-col gap-2 rounded-card border border-cloud bg-white p-4 shadow-[0_1px_2px_rgba(10,22,40,0.04)]';
export const STAT_LABEL = 'font-sans text-caption text-slate';
/** The tile's tinted icon chip (+ a TINT and a 16px icon). */
export const ICON_CHIP = 'flex size-8 shrink-0 items-center justify-center rounded-lg';
export const STAT_VALUE = 'font-heading text-h4 text-ink';
export const STAT_SUB = 'font-sans text-caption font-medium text-slate';
export const TINT = {
  brand: 'bg-frost text-cerulean',
  blue: 'bg-cerulean/10 text-cerulean',
  success: 'bg-sage/15 text-sage',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-alert/10 text-alert',
  teal: 'bg-teal/10 text-teal',
  neutral: 'bg-cloud text-slate',
} as const;
export type Tint = keyof typeof TINT;

// ----- People list (doctor Patients) -----
// The column template is per page, e.g. 'md:grid-cols-[minmax(0,1fr)_10rem_8rem_3rem]',
// shared by LIST_HEAD and every LIST_ROW so the columns line up.

export const LIST_FRAME =
  'md:overflow-hidden md:rounded-card md:border md:border-cloud md:bg-white md:shadow-[0_1px_2px_rgba(10,22,40,0.04)]';
export const LIST_HEAD =
  'hidden border-b border-cloud px-5 py-3 font-sans text-caption font-semibold text-slate md:grid md:items-center md:gap-4';
export const LIST_BODY = 'flex flex-col gap-3 md:gap-0 md:divide-y md:divide-cloud';
/** Below md each row is its own card; from md it is a divided row of the frame. */
export const LIST_ROW =
  'group relative flex flex-col gap-3 rounded-card border border-cloud bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-colors hover:border-cerulean/40 md:grid md:items-center md:gap-4 md:rounded-none md:border-0 md:px-5 md:py-4 md:shadow-none md:hover:bg-glacier';
/** The row's link: its ::after covers the whole row (and carries the focus ring). */
export const ROW_LINK =
  'flex min-w-0 items-center gap-3 text-left after:absolute after:inset-0 after:rounded-card focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-cerulean md:after:rounded-none';
/** Controls inside a linked row sit above the row link. */
export const ROW_ACTION_LAYER = 'relative z-10';
export const AVATAR =
  'flex size-12 shrink-0 items-center justify-center rounded-full bg-frost font-heading text-body-sm font-semibold text-cerulean';
export const AVATAR_SM =
  'flex size-10 shrink-0 items-center justify-center rounded-full bg-frost font-heading text-body-sm font-semibold text-cerulean';
export const ROW_TEXT = 'flex min-w-0 flex-col';
export const ROW_TITLE = 'truncate font-heading text-body-lg text-ink transition-colors group-hover:text-cerulean';
export const ROW_SUB = 'truncate font-sans text-body-sm text-slate';
/** A meta value with a 16px slate icon. */
export const ROW_META = 'flex min-w-0 items-center gap-2 font-sans text-body-sm text-ink';
/** The meta cells: one wrapped line on phones, their own grid columns from md. */
export const ROW_METAS = 'flex flex-wrap items-center gap-x-4 gap-y-2 md:contents';
/** The trailing "open" cue (chevron 20). */
export const ROW_CHEVRON = 'flex items-center gap-1 font-sans text-body-sm font-semibold text-cerulean';
export const ROW_CHEVRON_ICON = 'md:text-slate md:transition-colors md:group-hover:text-cerulean';
/** The row's last cell: actions + chevron (a top rule on phone cards). */
export const ROW_END = 'flex items-center justify-between gap-3 border-t border-cloud pt-3 md:justify-end md:border-0 md:pt-0';

// ----- Card-per-row list (doctor Schedule / History) -----

export const CARD_LIST = 'flex flex-col gap-4';
export const CARD_ROW =
  'group relative flex flex-col gap-4 rounded-card border border-cloud bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-colors hover:border-cerulean/40 lg:flex-row lg:items-center lg:gap-6';
/** A card in a list that is not a link (no hover). */
export const CARD_ITEM =
  'flex min-w-0 flex-col gap-3 rounded-card border border-cloud bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)]';

// ----- Data tables (ledgers: appointments, payouts, audit, monitoring) -----

export const TABLE_WRAP =
  'overflow-x-auto rounded-card border border-cloud bg-white shadow-[0_1px_2px_rgba(10,22,40,0.04)]';
export const TABLE = 'w-full text-left';
export const THEAD = 'border-b border-cloud font-sans text-caption font-semibold text-slate';
export const TH = 'px-5 py-3 font-semibold';
export const TBODY = 'divide-y divide-cloud';
export const TR = 'font-sans text-body-sm text-ink transition-colors hover:bg-glacier';
export const TD = 'px-5 py-4 align-middle';
export const TD_PRIMARY = 'font-semibold text-ink';
export const TD_SUB = 'block font-sans text-caption text-slate';
/**
 * A ledger row that is one link (add after TR). Its TABLE_ROW_LINK's ::after covers
 * the row; `[transform:scale(1)]` makes the row that overlay's containing block in
 * Safari as well. Other links in the row add ROW_ACTION_LAYER.
 */
export const TR_LINKED = 'group relative [transform:scale(1)]';
/** The row's link (its first cell's name): the ::after covers the whole row and carries the focus ring. */
export const TABLE_ROW_LINK =
  'font-semibold text-ink transition-colors group-hover:text-cerulean after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-cerulean';
/** A linked row's trailing cue (aria-hidden; optional word + `chevron-right` 20 in ROW_CHEVRON_ICON). */
export const TD_CUE = 'px-5 py-4 text-right align-middle';
export const ROW_CUE = 'inline-flex items-center justify-end gap-1 font-sans text-body-sm font-semibold text-cerulean';
/** A table cell that holds the row's action (right-aligned). */
export const TD_ACTION = 'px-5 py-4 text-right align-middle';
/** The row's "open" link in a ledger table (text + chevron, 44px tap target). */
export const TABLE_LINK =
  'inline-flex min-h-11 items-center gap-1 rounded-field px-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean ' +
  FOCUS_RING;
/** Empty / error state cell spanning the table… */
export const TD_EMPTY = 'px-5';
/** …and its content (+ a 28px icon, a line, an optional button). */
export const CELL_STATE = 'flex flex-col items-center justify-center gap-3 py-12 text-center font-sans text-body-sm text-slate';

// ----- Search & filters -----

/** Search row: box on the left, a results line on the right. */
export const SEARCH_ROW = 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between';
export const SEARCH_WRAP = 'w-full sm:max-w-md';
export const SEARCH_BOX =
  'group flex items-center gap-2 rounded-field border border-cloud bg-white px-4 shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-all duration-200 focus-within:border-cerulean focus-within:shadow-[0_2px_10px_rgba(21,101,192,0.08)] focus-within:ring-2 focus-within:ring-cerulean/20';
export const SEARCH_ICON = 'shrink-0 text-slate transition-colors group-focus-within:text-cerulean';
export const SEARCH_INPUT =
  'min-w-0 flex-1 bg-transparent py-3 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:outline-none [&::-webkit-search-cancel-button]:hidden';
export const SEARCH_CLEAR =
  '-mr-1.5 flex size-8 shrink-0 items-center justify-center rounded-full text-slate transition-colors hover:bg-cloud hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40';
export const SEARCH_RESULTS = 'font-sans text-body-sm text-slate';
/** The one pill segmented control (filters, ranges). */
export const SEGMENTED = 'flex w-fit max-w-full gap-1 overflow-x-auto rounded-pill border border-cloud bg-white p-1';
/** Many options: wraps into rows on phones (every option visible), one pill bar from sm up. Buttons add SEGMENT_FILL. */
export const SEGMENTED_WRAP =
  'flex w-full flex-wrap gap-1 rounded-card border border-cloud bg-white p-1 sm:w-fit sm:max-w-full sm:flex-nowrap sm:overflow-x-auto sm:rounded-pill';
export const SEGMENT_FILL = 'flex-auto justify-center sm:flex-none';
export const SEGMENT =
  'flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors sm:px-5 ' +
  FOCUS_RING;
export const SEGMENT_ON = 'bg-frost text-cerulean';
export const SEGMENT_OFF = 'text-slate hover:text-ink';
export const SEGMENT_COUNT = 'flex size-5 items-center justify-center rounded-full text-[11px] font-semibold';
export const SEGMENT_COUNT_ON = 'bg-cerulean text-white';
export const SEGMENT_COUNT_OFF = 'bg-cloud text-slate';
/** Filter chips (status filters with counts). */
export const FILTER_CHIPS = 'flex flex-wrap gap-2';
export const FILTER_CHIP =
  'inline-flex min-h-11 items-center gap-1.5 rounded-pill px-3.5 py-2 font-sans text-body-sm transition-colors ' + FOCUS_RING;
export const FILTER_CHIP_ON = 'bg-cerulean text-white';
export const FILTER_CHIP_OFF = 'bg-white text-slate ring-1 ring-cloud hover:text-ink';
export const FILTER_CHIP_HOT = 'bg-warning/10 text-ink ring-1 ring-warning/40 hover:bg-warning/20';

// ----- Forms -----

/** The 48px field. */
export const FIELD =
  'w-full min-w-0 rounded-field border border-[#b8c6d4] bg-white px-4 py-3 font-sans text-body-sm text-ink shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-all duration-200 placeholder:text-slate/60 hover:border-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20 disabled:cursor-not-allowed disabled:bg-cloud/40 disabled:text-slate';
/** A field with a leading icon: wrap in `relative`, icon is FIELD_ICON (20px). */
export const FIELD_WITH_ICON =
  'w-full min-w-0 rounded-field border border-[#b8c6d4] bg-white py-3 pr-4 pl-11 font-sans text-body-sm text-ink shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-all duration-200 placeholder:text-slate/60 hover:border-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20 disabled:cursor-not-allowed disabled:bg-cloud/40 disabled:text-slate';
export const FIELD_ICON = 'pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate';
export const FIELD_INVALID = '!border-alert focus:!ring-alert/20';
/** An input with a unit suffix (₦, %, minutes). */
export const FIELD_GROUP =
  'flex items-stretch overflow-hidden rounded-field border border-[#b8c6d4] bg-white shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-colors focus-within:border-cerulean focus-within:ring-2 focus-within:ring-cerulean/20';
export const FIELD_GROUP_INPUT = 'w-full min-w-0 flex-1 bg-transparent px-4 py-3 font-sans text-body-sm text-ink focus:outline-none';
export const FIELD_PREFIX = 'flex shrink-0 items-center border-r border-cloud bg-glacier px-3 font-sans text-caption text-slate';
export const FIELD_SUFFIX = 'flex shrink-0 items-center border-l border-cloud bg-glacier px-3 font-sans text-caption text-slate';
/** Compact label (dialogs, settings cards, filters). */
export const LABEL = 'font-sans text-caption font-semibold text-slate';
/** Page-form label (Edit Profile tier). */
export const LABEL_LG = 'font-sans text-body font-semibold text-ink';
/** A label + control + hint stack. */
export const FIELD_STACK = 'flex min-w-0 flex-col gap-1.5';
export const HINT = 'font-sans text-caption text-slate';
export const FIELD_ERROR = 'flex items-start gap-1.5 font-sans text-caption text-alert';
export const FORM_GRID = 'grid gap-4 sm:grid-cols-2';
export const FORM_ACTIONS = 'flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end';
/** A checkbox / radio row (control `size-5 accent-cerulean`). */
export const CHECK_ROW = 'flex min-h-11 cursor-pointer items-center gap-2';
export const CHECKBOX = 'size-5 shrink-0 accent-cerulean';
/** sd-dialog's footer (same as the doctor portal). */
export const DIALOG_FOOTER =
  'flex flex-col-reverse gap-2 border-t border-cloud px-5 py-4 sm:flex-row sm:justify-end sm:px-6';

// ----- Buttons (prefer <sd-button>; these are for <a routerLink> and native buttons) -----

export const BTN_PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:cursor-not-allowed disabled:opacity-60 ' +
  FOCUS_RING;
export const BTN_SUCCESS =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field bg-sage px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60 ' +
  FOCUS_RING;
export const BTN_DANGER =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field bg-alert px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-alert/90 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-alert/40';
export const BTN_SECONDARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field border border-cloud bg-white px-4 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:cursor-not-allowed disabled:opacity-60 ' +
  FOCUS_RING;
export const BTN_DANGER_OUTLINE =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field border border-alert/40 bg-white px-4 py-2.5 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-alert/40';
export const BTN_SUCCESS_OUTLINE =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field border border-sage/50 bg-white px-4 py-2.5 font-sans text-body-sm font-semibold text-sage transition-colors hover:bg-sage/5 disabled:cursor-not-allowed disabled:opacity-60 ' +
  FOCUS_RING;
export const BTN_GHOST =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field px-4 py-2.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:bg-glacier hover:text-ink disabled:opacity-60 ' +
  FOCUS_RING;
/** Add to a BTN_* (44px) that sits in one row with a 48px FIELD / SEARCH_BOX, so their edges line up. */
export const BTN_BESIDE_FIELD = 'sm:min-h-12';
/** A small action inside a list row (sits above the row link). */
export const BTN_ROW =
  'relative z-10 inline-flex min-h-11 items-center justify-center gap-1.5 rounded-field border border-cloud bg-white px-3 py-2 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean disabled:cursor-not-allowed disabled:opacity-60 ' +
  FOCUS_RING;
/** An icon-only button (44px). */
export const BTN_ICON =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-field border border-cloud bg-white text-slate transition-colors hover:border-cerulean hover:text-cerulean disabled:cursor-not-allowed disabled:opacity-50 ' +
  FOCUS_RING;

// ----- Badges -----

/** Status pill (+ a 13px icon). */
export const PILL = 'inline-flex w-fit items-center gap-1 rounded-pill px-3 py-0.5 font-sans text-caption font-semibold';
/** Info / role chip (+ a 14px icon). */
export const CHIP = 'inline-flex w-fit items-center gap-1.5 rounded-pill px-3 py-1 font-sans text-caption font-medium';
export const TAG = 'rounded-pill bg-frost px-3 py-1 font-sans text-caption font-medium text-cerulean';
