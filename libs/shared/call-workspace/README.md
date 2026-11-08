# shared-call-workspace

The call workspace shared by the call pages (`@supadoc/call-workspace`): one large modal over a
call cockpit that holds the page's tools as tabs, with the call band on top and the other
side's live video as its picture-in-picture, like the shared document viewer.

- `CallWorkspace<K>` (`sd-call-workspace`): the shell. The call page declares its panels in its
  own template and projects them (`<div sdWsPanel="notes">…</div>`, the `WorkspacePanel`
  directive), so closing the modal destroys none of their state. Every word it shows comes from
  its inputs (`kicker`, `title`, `closeLabel`, `tablistLabel`, `shareText`, the tabs and their
  marks), apart from the viewer's own copy (Show video, Hide video, Stop sharing…).
- `WorkspaceFlag`: a tab's mark, `{ mark: 'warn' | 'live' | 'new', sr }`. The shell draws the dot;
  `sr` is the app's own screen-reader words (", unsaved changes").
- `PeerHandover`: one owner of the peer's video at a time (the cockpit's stage, the workspace's
  tile or the document viewer's tile).

The class names `.ws-frame`, `.ws-band`, `.ws-scroll`, `.ws-inner`, `.ws-pip`, `.ws-share`,
`.ws-tabs`, `.ws-flag-unsaved` and the ids `ws-tab-<key>` / `ws-panel-<key>` are relied on by the
call pages and their checks: keep them.

## Keeping it out of the initial bundles

Import `@supadoc/call-workspace` only from lazily loaded call pages (the doctor's `doctor-call.ts`).
An import from eager code puts the shell in `main`. Its stylesheet is component CSS (`WS_CSS`,
under the 4,000-byte component budget), never new Tailwind utilities, which would land in every
app's initial `styles.css`. `bundle-guard.spec.ts` keeps out the patterns that grow `main` from
lazy code (a `[style]` map binding, rxjs's timer, a namespace import used as a value, an eased
timing keyword in a CSS string).

Run `pnpm nx test shared-call-workspace` and `pnpm nx lint shared-call-workspace`.
