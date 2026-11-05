import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';

/*
 * Open guard (spec P-15): every document preview opens in the shared viewer
 * (`DocumentViewerService`, @supadoc/viewer), a modal. Nothing in the patient
 * app may open a document in a tab or hand its bytes to the browser as a URL —
 * a blocked popup used to navigate this tab instead, which ended a live call:
 *  - no openBlobDocument / openClinicalDocument / openPendingTab (import or call);
 *  - no object URLs (the viewer's Download is the one way to save a file);
 *  - no window opening with anything but a same-origin path ('/…'): window /
 *    globalThis / self .open, a bare open(…) with an argument (a zero-argument
 *    open() is a local callback, e.g. dashboard-home's whenNoOtherOverlay), and
 *    *.defaultView.open / defaultView?.open.
 * lint-fixtures/open-guard.fixture.ts proves each case is flagged.
 */
/*
 * A same-origin path: '/' then a path character. Never '//' or '/\' (a browser
 * reads both as another host, after dropping tabs and newlines), and never a
 * bare '/' in front of an expression ('/' + x, `/${x}`), whose x may supply the
 * second slash. (`\x2F`: esquery ends a regex at its first literal slash.)
 */
const SAME_ORIGIN_PATH = '/^\\x2F[\\w-]/';
const samePath =
  `:not([arguments.0.value=${SAME_ORIGIN_PATH}])` +
  `:not([arguments.0.quasis.0.value.raw=${SAME_ORIGIN_PATH}])` +
  `:not([arguments.0.left.value=${SAME_ORIGIN_PATH}])` +
  `:not([arguments.0.left.left.value=${SAME_ORIGIN_PATH}])`;
const message = 'Documents open in the shared viewer (DocumentViewerService, @supadoc/viewer), never in a tab or as a URL.';
const windowMessage = `${message} A window may only open a same-origin path ('/…').`;
const OLD_HELPERS = '/^(openBlobDocument|openClinicalDocument|openPendingTab)$/';
const bareOpen = { selector: `CallExpression[callee.name='open'][arguments.0]${samePath}`, message: windowMessage };
const OPEN_GUARD = [
  { selector: `CallExpression[callee.name=${OLD_HELPERS}]`, message },
  { selector: `ImportSpecifier[imported.name=${OLD_HELPERS}]`, message },
  { selector: "MemberExpression[property.name='createObjectURL']", message },
  { selector: `CallExpression[callee.object.name='window'][callee.property.name='open']${samePath}`, message: windowMessage },
  { selector: `CallExpression[callee.object.name=/^(globalThis|self)$/][callee.property.name='open']${samePath}`, message: windowMessage },
  bareOpen,
  { selector: `CallExpression[callee.property.name='open'][callee.object.property.name='defaultView']${samePath}`, message: windowMessage },
  {
    // `doc.defaultView?.open(…)`: the optional member sits inside a ChainExpression.
    selector: `CallExpression[callee.property.name='open'][callee.object.expression.property.name='defaultView']${samePath}`,
    message: windowMessage,
  },
];

/**
 * A glob under this project, whichever base ESLint uses: Nx lints from the
 * workspace root with this file as the config (patterns relative to the root),
 * an editor from this folder (relative to it).
 */
const here = (glob) => [glob, `apps/patient/${glob}`];

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
          prefix: 'pat',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'pat',
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
    // Specs name their own helpers open(…) (open the dialog under test): every other ban still applies.
    files: here('src/**/*.spec.ts'),
    rules: { 'no-restricted-syntax': ['error', ...OPEN_GUARD.filter((s) => s !== bareOpen)] },
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
