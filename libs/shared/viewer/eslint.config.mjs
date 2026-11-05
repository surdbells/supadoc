import nx from '@nx/eslint-plugin';
import baseConfig from '../../../eslint.config.mjs';

/*
 * The shared viewer's guard (spec §1.11). The viewer shows medical documents,
 * so nothing in it may hand bytes to the browser as a URL, open a window, or
 * write HTML:
 *  - object URLs only in save-file.ts (Download), media-url.ts (<video>) and
 *    print-pages.ts (the print root's images);
 *  - no window opening of any kind (window / globalThis / self .open, a bare
 *    open(…), *.defaultView.open / defaultView?.open);
 *  - no innerHTML / outerHTML, insertAdjacentHTML, document.write or
 *    bypassSecurityTrust*.
 * lint-fixtures/viewer-guard.fixture.ts proves each one is flagged.
 */
const message = 'The shared viewer never hands documents to the browser as URLs or HTML (spec §1.11).';
const objectUrls = { selector: "MemberExpression[property.name='createObjectURL']", message };
const windows = [
  { selector: "CallExpression[callee.object.name='window'][callee.property.name='open']", message },
  { selector: "CallExpression[callee.object.name=/^(globalThis|self)$/][callee.property.name='open']", message },
  { selector: "CallExpression[callee.name='open']", message },
  { selector: "CallExpression[callee.property.name='open'][callee.object.property.name='defaultView']", message },
  { selector: "CallExpression[callee.property.name='open'][callee.object.expression.property.name='defaultView']", message },
];
const html = [
  { selector: 'MemberExpression[property.name=/^(innerHTML|outerHTML)$/]', message },
  { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message },
  { selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]", message },
  { selector: "MemberExpression[property.name=/^(write|writeln)$/][object.property.name='document']", message },
  { selector: 'MemberExpression[property.name=/^bypassSecurityTrust/]', message },
  { selector: 'ImportSpecifier[imported.name=/^bypassSecurityTrust/]', message },
];
const GUARD = [objectUrls, ...windows, ...html];

/** A glob under this project, whichever base ESLint uses (Nx: the workspace root; an editor: this folder). */
const here = (glob) => [glob, `libs/shared/viewer/${glob}`];

export default [
  ...nx.configs['flat/angular'],
  ...nx.configs['flat/angular-template'],
  ...baseConfig,
  {
    files: ['**/*.ts'],
    rules: {
      '@angular-eslint/directive-selector': ['error', { type: 'attribute', prefix: 'sd', style: 'camelCase' }],
      '@angular-eslint/component-selector': ['error', { type: 'element', prefix: 'sd', style: 'kebab-case' }],
    },
  },
  {
    files: [...here('src/**/*.ts'), ...here('lint-fixtures/**/*.ts')],
    rules: { 'no-restricted-syntax': ['error', ...GUARD] },
  },
  {
    // The three places an object URL may be made.
    files: [...here('src/lib/save-file.ts'), ...here('src/lib/media-url.ts'), ...here('src/lib/print-pages.ts')],
    rules: { 'no-restricted-syntax': ['error', ...windows, ...html] },
  },
  {
    // Specs stub object URLs and inspect the DOM.
    files: here('src/**/*.spec.ts'),
    rules: { 'no-restricted-syntax': ['error', ...windows] },
  },
  {
    // The guard's own proof: a flagged line's disable comment must be used.
    files: here('lint-fixtures/**/*.ts'),
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['**/*.html'],
    rules: {},
  },
];
