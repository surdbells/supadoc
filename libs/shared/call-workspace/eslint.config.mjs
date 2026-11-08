import nx from '@nx/eslint-plugin';
import baseConfig from '../../../eslint.config.mjs';

/*
 * The call workspace's guard. It holds a call page's clinical tools over a live
 * call, so nothing in it may leave the call or write HTML:
 *  - no window opening of any kind (window / globalThis / self .open, a bare
 *    open(…), *.defaultView.open / defaultView?.open);
 *  - no innerHTML / outerHTML, insertAdjacentHTML, document.write or
 *    bypassSecurityTrust*.
 * It runs inside the doctor's call page, so it also keeps the doctor app's
 * download guard (apps/doctor/eslint.config.mjs), which covers apps/doctor only:
 * doctors may only view or print patient documents, in the call page's shared
 * viewer. So, nowhere in this lib:
 *  - no object URLs;
 *  - no old open-in-a-tab helpers (openBlobDocument, openPendingTab,
 *    openClinicalDocument) and no patientDocumentBlob;
 *  - no saveBlob;
 *  - no embedded viewer (@supadoc/viewer/embed, imported or re-exported): the
 *    lib takes copy only from the light entry, @supadoc/viewer;
 *  - no view-only routes (patientDocumentView, viewResult): only the apps'
 *    source builders call them.
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

/* The doctor app's download guard, as it stands in apps/doctor/eslint.config.mjs (its window rules are the stricter ones above). */
const docMessage =
  'Patient documents are view-only in the doctor app, and the call workspace runs in its call page: documents open in the shared viewer (DocumentViewerService), never as a URL, a tab, a saved file or an embedded viewer.';
const objectUrls = { selector: "MemberExpression[property.name='createObjectURL']", message: docMessage };
/** An old way of opening a document in a tab, called or imported. */
const oldOpenPath = ['openBlobDocument', 'openPendingTab', 'openClinicalDocument'].flatMap((name) => [
  { selector: `CallExpression[callee.name='${name}']`, message: docMessage },
  { selector: `ImportSpecifier[imported.name='${name}']`, message: docMessage },
]);
const oldBlobCall = { selector: "MemberExpression[property.name='patientDocumentBlob']", message: docMessage };
const saveBlobImport = { selector: "ImportSpecifier[imported.name='saveBlob']", message: docMessage };
const embedMessage = `${docMessage} The lib takes copy only from the light entry, @supadoc/viewer.`;
const embedImport = [
  { selector: "ImportDeclaration[source.value='@supadoc/viewer/embed']", message: embedMessage },
  // Re-exports too: export { DocumentViewerComponent } from …, export * from …
  { selector: "ExportNamedDeclaration[source.value='@supadoc/viewer/embed']", message: embedMessage },
  { selector: "ExportAllDeclaration[source.value='@supadoc/viewer/embed']", message: embedMessage },
];
const viewOnlyRoutes = {
  selector: 'MemberExpression[property.name=/^(patientDocumentView|viewResult)$/]',
  message: `${docMessage} The view-only routes are only wrapped by viewOnlySource, in the apps' source builders.`,
};
const DOWNLOAD_GUARD = [objectUrls, ...oldOpenPath, oldBlobCall, saveBlobImport, ...embedImport, viewOnlyRoutes];

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
    rules: { 'no-restricted-syntax': ['error', ...windows, ...html, ...DOWNLOAD_GUARD] },
  },
  {
    files: ['**/*.html'],
    rules: {},
  },
];
