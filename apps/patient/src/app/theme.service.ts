import { Injectable, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'videomed.theme';

/**
 * Patient-portal theme (light/dark). The initial `data-theme` is set by an inline
 * script in index.html before first paint (no flash); this service keeps the
 * signal in sync, lets the UI toggle it, and persists the choice. When the user
 * has never chosen, we follow the OS `prefers-color-scheme`.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  /** The active theme, reflected on `<html data-theme>`. */
  readonly theme = signal<Theme>(this.readInitial());

  constructor() {
    this.apply(this.theme());
  }

  toggle(): void {
    this.set(this.theme() === 'dark' ? 'light' : 'dark');
  }

  set(theme: Theme): void {
    this.theme.set(theme);
    this.apply(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* preference is best-effort */
    }
  }

  private apply(theme: Theme): void {
    const root = document.documentElement;
    if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
  }

  private readInitial(): Theme {
    // Trust whatever the pre-paint script already resolved onto <html>.
    if (document.documentElement.getAttribute('data-theme') === 'dark') {
      return 'dark';
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {
      /* ignore */
    }
    return typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
}
