/** One tab of the workspace (and, on the call page, the launcher that opens it). */
export interface WorkspaceTabDef<K extends string = string> {
  readonly key: K;
  readonly label: string;
  /** A registered Lucide icon name. */
  readonly icon: string;
}

/**
 * A small mark on a tab, drawn by the shell: `warn` a warning dot, `live` a
 * pulsing alert dot, `new` a cerulean dot. `sr` is the app's own words for
 * screen readers, read after the tab's label, so it starts with ", "
 * (", unsaved changes"). The shell never holds an app's copy.
 */
export interface WorkspaceFlag {
  readonly mark: 'warn' | 'live' | 'new';
  readonly sr: string;
}
