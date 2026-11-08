import nx from '@nx/eslint-plugin';
import baseConfig from '../../../eslint.config.mjs';

/*
 * The call workspace's guard. It holds a call page's clinical tools over a live
 * call, so nothing in it may leave the call or write HTML:
 *  - no window opening of any kind (window / globalThis / self .open, a bare
 *    open(…), *.defaultView.open / defaultView?.open);
 *  - no innerHTML / outerHTML, insertAdjacentHTML, document.write or
 *    bypassSecurityTrust*.
 */
const message = 'The call workspace never leaves the call and never writes HTML.';
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

/** A glob under this project, whichever base ESLint uses (Nx: the workspace root; an editor: this folder). */
const here = (glob) => [glob, `libs/shared/call-workspace/${glob}`];

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
    files: here('src/**/*.ts'),
    rules: { 'no-restricted-syntax': ['error', ...windows, ...html] },
  },
  {
    files: ['**/*.html'],
    rules: {},
  },
];
