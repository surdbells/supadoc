import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';

/*
 * Download guard: doctors may only VIEW or PRINT patient documents, in the
 * shared viewer (`@supadoc/viewer`, opened through DocumentViewerService).
 * Nothing in the doctor app may hand a patient file to the browser as a URL,
 * a tab or a saved file, or show it any other way:
 *  - no object URLs (the viewer makes its own, inside the lib);
 *  - no old open-in-a-tab helpers (openBlobDocument, openPendingTab,
 *    openClinicalDocument) and no patientDocumentBlob;
 *  - no saveBlob (hosts save signed links through saveSignedLink only);
 *  - no embedded viewer (@supadoc/viewer/embed): every view goes through the
 *    service and its every-build policy checks;
 *  - the view-only routes (patientDocumentView, viewResult) only in the source
 *    builders (src/app/viewer/doctor-viewer-sources.ts, and the Lab batch's
 *    src/app/lab/lab-viewer-sources.ts), which wrap them in viewOnlySource;
 *  - opening a window only with a same-origin path ('/auth/login',
 *    '/patients/' + id, `/patients/${id}`) — never '' (a blank tab to write a
 *    blob into), a URL, or a protocol-relative one ('//host/…', and '/\host'
 *    or a '/' + tab, which browsers read the same way) — whichever way it is
 *    called: window.open, globalThis.open / self.open, a bare open(…), or
 *    *.defaultView(?).open.
 * lint-fixtures/download-guard.fixture.ts proves each case is flagged.
 */
/** A '/' and then a path character: not '//', '/\' or '/' + whitespace (another origin), nor a bare '/'. */
const SAME_ORIGIN_PATH = '/^\\x2F[^\\x2F\\x5C\\s]/';
const message = 'Patient documents are view-only in the doctor app: open them in the shared viewer (DocumentViewerService, src/app/viewer/doctor-viewer-sources.ts).';
const objectUrls = { selector: "MemberExpression[property.name='createObjectURL']", message };
/** An old way of opening a document in a tab, called or imported. */
const oldOpenPath = ['openBlobDocument', 'openPendingTab', 'openClinicalDocument'].flatMap((name) => [
  { selector: `CallExpression[callee.name='${name}']`, message },
  { selector: `ImportSpecifier[imported.name='${name}']`, message },
]);
const oldBlobCall = { selector: "MemberExpression[property.name='patientDocumentBlob']", message };
const saveBlobImport = {
  selector: "ImportSpecifier[imported.name='saveBlob']",
  message: `${message} Hosts never save blobs: Download a signed link with saveSignedLink.`,
};
/*
 * (A dynamic import() of it is not listed: it would make the viewer a lazy-loaded
 * library of this app, and @nx/enforce-module-boundaries then refuses every static
 * import of @supadoc/viewer — so that path fails lint already.)
 */
const embedMessage = `${message} The doctor app never embeds the viewer.`;
const embedImport = [
  { selector: "ImportDeclaration[source.value='@supadoc/viewer/embed']", message: embedMessage },
  // Re-exports too: export { DocumentViewerComponent } from …, export * from …
  { selector: "ExportNamedDeclaration[source.value='@supadoc/viewer/embed']", message: embedMessage },
  { selector: "ExportAllDeclaration[source.value='@supadoc/viewer/embed']", message: embedMessage },
];
const viewOnlyRoutes = {
  selector: 'MemberExpression[property.name=/^(patientDocumentView|viewResult)$/]',
  message: `${message} The view-only routes are only wrapped by viewOnlySource, in the doctor's source builders.`,
};
/** The first argument is a same-origin path ('/p…', '/p…' + x, `/p…${x}`, '/p…' + x + y). */
const sameOriginPath =
  `:not([arguments.0.value=${SAME_ORIGIN_PATH}])` +
  `:not([arguments.0.quasis.0.value.raw=${SAME_ORIGIN_PATH}])` +
  `:not([arguments.0.left.value=${SAME_ORIGIN_PATH}])` +
  `:not([arguments.0.left.left.value=${SAME_ORIGIN_PATH}])`;
const openMessage = `${message} Opening a window may only take a same-origin path ('/…').`;
const windowOpen = [
  // window.open(…)
  { selector: `CallExpression[callee.object.name='window'][callee.property.name='open']${sameOriginPath}`, message: openMessage },
  // globalThis.open(…), self.open(…)
  { selector: `CallExpression[callee.object.name=/^(globalThis|self)$/][callee.property.name='open']${sameOriginPath}`, message: openMessage },
  // open(…)
  { selector: `CallExpression[callee.name='open']${sameOriginPath}`, message: openMessage },
  // this.doc.defaultView.open(…), document.defaultView?.open(…) (the optional call is inside a ChainExpression)
  { selector: `CallExpression[callee.property.name='open'][callee.object.property.name='defaultView']${sameOriginPath}`, message: openMessage },
];
/**
 * A glob under this project, whichever base ESLint uses: Nx lints from the
 * workspace root with this file as the config (patterns relative to the root),
 * an editor from this folder (relative to it).
 */
const here = (glob) => [glob, `apps/doctor/${glob}`];
/** Everything but the view-only routes rule (for the files allowed to call them). */
const GUARD_BUT_ROUTES = [objectUrls, ...oldOpenPath, oldBlobCall, saveBlobImport, ...embedImport, ...windowOpen];
const DOWNLOAD_GUARD = [...GUARD_BUT_ROUTES, viewOnlyRoutes];

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
    // The source builders (they wrap the view-only routes in viewOnlySource), and specs (their stubs).
    files: [
      ...here('src/app/viewer/doctor-viewer-sources.ts'),
      ...here('src/app/lab/lab-viewer-sources.ts'),
      ...here('src/**/*.spec.ts'),
    ],
    rules: { 'no-restricted-syntax': ['error', ...GUARD_BUT_ROUTES] },
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
