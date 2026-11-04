import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';

/*
 * Download guard: doctors may only VIEW or PRINT patient documents (in the
 * view-only viewer, src/app/viewer). Nothing in the doctor app may hand a
 * patient file to the browser as a URL or a tab:
 *  - no object URLs (the viewer's own <video> and print root are the exception);
 *  - no openBlobDocument / patientDocumentBlob (the old open-in-a-tab path);
 *  - window.open only with a same-origin path ('/auth/login', '/patients/' + id,
 *    `/patients/${id}`) — never '' (a blank tab to write a blob into) or a URL.
 * lint-fixtures/download-guard.fixture.ts proves each case is flagged.
 */
const SAME_ORIGIN_PATH = '/^\\x2F/';
const message = 'Patient documents are view-only in the doctor app: open them in the protected viewer (src/app/viewer).';
const objectUrls = { selector: "MemberExpression[property.name='createObjectURL']", message };
const oldOpenPath = [
  { selector: "CallExpression[callee.name='openBlobDocument']", message },
  { selector: "ImportSpecifier[imported.name='openBlobDocument']", message },
];
const oldBlobCall = { selector: "MemberExpression[property.name='patientDocumentBlob']", message };
const windowOpen = {
  selector:
    "CallExpression[callee.object.name='window'][callee.property.name='open']" +
    `:not([arguments.0.value=${SAME_ORIGIN_PATH}])` +
    `:not([arguments.0.quasis.0.value.raw=${SAME_ORIGIN_PATH}])` +
    `:not([arguments.0.left.value=${SAME_ORIGIN_PATH}])` +
    `:not([arguments.0.left.left.value=${SAME_ORIGIN_PATH}])`,
  message: `${message} window.open may only take a same-origin path ('/…').`,
};
/**
 * A glob under this project, whichever base ESLint uses: Nx lints from the
 * workspace root with this file as the config (patterns relative to the root),
 * an editor from this folder (relative to it).
 */
const here = (glob) => [glob, `apps/doctor/${glob}`];
const DOWNLOAD_GUARD = [objectUrls, ...oldOpenPath, oldBlobCall, windowOpen];

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
          prefix: 'doc',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'doc',
          style: 'kebab-case',
        },
      ],
    },
  },
  {
    files: [...here('src/**/*.ts'), ...here('lint-fixtures/**/*.ts')],
    rules: { 'no-restricted-syntax': ['error', ...DOWNLOAD_GUARD] },
  },
  {
    // The viewer plays its own <video> and builds the print root from object URLs.
    files: here('src/app/viewer/**/*.ts'),
    rules: { 'no-restricted-syntax': ['error', ...oldOpenPath, oldBlobCall, windowOpen] },
  },
  {
    // The doctor's OWN credential files (not patient documents).
    files: here('src/app/onboarding/credentials.ts'),
    rules: { 'no-restricted-syntax': ['error', objectUrls, oldBlobCall, windowOpen] },
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
