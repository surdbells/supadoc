# shared-viewer

The one premium document viewer, opened in a modal everywhere (`@supadoc/viewer`).

- `@supadoc/viewer` (light): `DocumentViewerService`, the types, the policies, the source
  builders (`blobSource`, `viewOnlySource`, `signedLinkSource`), `saveSignedLink`,
  `provideViewerDefaults`, the copy, `viewerKind`, `PDF_LOADER` and `CallPeerTileComponent`
  (`sd-call-peer-tile`, for a call page's registered peer template). The outlet and the viewer
  body are loaded only by the service's relative dynamic imports, each its own lazy chunk;
  pdf.js is a third chunk, loaded on the first PDF.
- `@supadoc/viewer/embed` (heavy): `DocumentViewerComponent` (`sd-document-viewer`) for hosts that
  embed it in their own dialog (back office). Banned in the doctor app.

## Keeping it out of the initial bundles

The workspace's own code is not tree-shaken by the application build: a module reached from
eager code lands in `main` whole, with every class it exports. So:

- import `@supadoc/viewer` only from lazily loaded files (route components, their dialogs and
  services used only there). One import from eager code (an `app.config.ts`, an app-root
  component or a root store it uses) puts the light entry, about 25 kB, in the initial bundle;
- an eager host opens the viewer with `const { DocumentViewerService, blobSource } = await import('@supadoc/viewer');`
  and `injector.get(DocumentViewerService).open(…)`;
- the tone already defaults to `'auto'` (it follows `html[data-theme]`), so no app needs
  `provideViewerDefaults` in its root providers;
- the outlet creates the body with a `ViewContainerRef`, not `@defer` (the first `@defer` in an
  app adds Angular's deferred-loading runtime, about 15 kB, to `main`), and the viewer's own
  icons are inline icon data, not `Lucide…` classes (those land in `main`).

Lazy-only code can still grow `main`: the build moves code that several lazy chunks share into
it. `bundle-guard.spec.ts` keeps out what that costs here: a `[style]` map binding (Angular's
style-map parser, about 1 kB; the colour tokens are written by `applyViewerTokens`), rxjs's
timer operator (about 0.2 kB), a namespace import used as a value (esbuild's export helper), and
an eased timing keyword in a CSS string (Tailwind adds that utility to every app's styles).

Measured with the patient Documents page (lazy) opening the viewer: `main` grows by about
0.7 kB on top of Wave 0's 1.1 kB (initial total +1.8 kB against `ea1f381`). What remains is
esbuild's `for await` helper (pdf.js's, shared with the Agora chunk; the doctor app already has
it), `createComponent` (the service mounts the outlet with it, D2) and the extra cross-chunk
exports of `main`.

Run `pnpm nx test shared-viewer` and `pnpm nx lint shared-viewer`.
