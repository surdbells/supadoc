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

/**
 * What a launcher says under its label: short visible words (`text`), the rest
 * for screen readers (`sr`), and a tone: `muted` a plain caption, `warn` the
 * warning colour, `live` a pulsing alert dot, `new` a dot in the "new" colour.
 * The words are the app's own; a launcher's height never changes with it.
 */
export interface LauncherStatus {
  readonly text: string;
  readonly sr?: string;
  readonly tone: 'muted' | 'warn' | 'live' | 'new';
}

/** A launcher was pressed: which tab, and the button (focus returns to it when the workspace closes). */
export interface LauncherOpen<K extends string = string> {
  readonly key: K;
  readonly opener: HTMLElement;
}
