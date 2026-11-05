import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';

/*
 * Open guard (document viewer spec §6.4, O-6): every document opens in the
 * shared viewer, never in a browser tab. Nothing in the onboarding app may:
 *  - use the old open-in-a-tab helpers (openBlobDocument, openClinicalDocument,
 *    openPendingTab), as a call or an import;
 *  - open a window except on a same-origin path ('/x…'): window.open,
 *    globalThis.open / self.open, a bare open(…) and *.defaultView.open /
 *    defaultView?.open / defaultView!.open.
 * Object URLs stay allowed: the calendar download (core/ics.ts) uses one.
 * lint-fixtures/open-guard.fixture.ts proves each case is flagged.
 */
/**
 * A same-origin path: '/' then a character that keeps it one. A second '/' or a
 * '\' ('//host', '/\host'), or whitespace (URL parsing drops tabs and newlines:
 * '/\t/host'), makes it protocol-relative, so cross-origin. '/' + x and `/${x}`
 * are flagged too: x could start with '/'.
 */
const SAME_ORIGIN_PATH = '/^\\x2F[^\\x2F\\x5C\\s]/';
const message = 'Documents open in the shared viewer (DocumentViewerService), never in a browser tab.';
const oldHelpers = [
  { selector: "CallExpression[callee.name=/^(openBlobDocument|openClinicalDocument|openPendingTab)$/]", message },
  { selector: "ImportSpecifier[imported.name=/^(openBlobDocument|openClinicalDocument|openPendingTab)$/]", message },
];
/** No same-origin-path first argument ('/x', '/x/' + id, `/x/${id}`; never '//host'). */
const notPath =
  `:not([arguments.0.value=${SAME_ORIGIN_PATH}])` +
  `:not([arguments.0.quasis.0.value.raw=${SAME_ORIGIN_PATH}])` +
  `:not([arguments.0.left.value=${SAME_ORIGIN_PATH}])` +
  `:not([arguments.0.left.left.value=${SAME_ORIGIN_PATH}])`;
const windowMessage = `${message} A window may only open on a same-origin path ('/…').`;
const windows = [
  { selector: `CallExpression[callee.object.name='window'][callee.property.name='open']${notPath}`, message: windowMessage },
  { selector: `CallExpression[callee.object.name=/^(globalThis|self)$/][callee.property.name='open']${notPath}`, message: windowMessage },
  { selector: `CallExpression[callee.property.name='open'][callee.object.property.name='defaultView']${notPath}`, message: windowMessage },
  { selector: `CallExpression[callee.property.name='open'][callee.object.expression.property.name='defaultView']${notPath}`, message: windowMessage },
];
/** A bare open(…) (the global window.open). Specs are exempt: their local `open()` helpers render a page. */
const bareOpen = { selector: `CallExpression[callee.name='open']${notPath}`, message: windowMessage };
const OPEN_GUARD = [...oldHelpers, ...windows, bareOpen];

/**
 * A glob under this project, whichever base ESLint uses: Nx lints from the
 * workspace root with this file as the config (patterns relative to the root),
 * an editor from this folder (relative to it).
 */
const here = (glob) => [glob, `apps/onboarding/${glob}`];

export default [
  ...nx.configs['flat/angular'],
  ...nx.configs['flat/angular-template'],
  ...baseConfig,
  {
    files: ['**/*.ts'],
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'onb',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'onb',
          style: 'kebab-case',
        },
      ],
    },
  },
  {
    files: [...here('src/**/*.ts'), ...here('lint-fixtures/**/*.ts')],
    rules: { 'no-restricted-syntax': ['error', ...OPEN_GUARD] },
  },
  {
    files: here('src/**/*.spec.ts'),
    rules: { 'no-restricted-syntax': ['error', ...oldHelpers, ...windows] },
  },
  {
    // The guard's own proof: a flagged line's disable comment must be used.
    files: here('lint-fixtures/**/*.ts'),
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['**/*.html'],
    // Override or add rules here
    rules: {},
  },
];
