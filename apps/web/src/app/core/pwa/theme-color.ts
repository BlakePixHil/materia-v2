import { DOCUMENT, effect, inject, Injectable } from '@angular/core';

import { ThemeService } from '@materia/ui';

/** The browser bar's colour per theme: the `bg-surface` token, as in index.html and the manifest. */
export const THEME_COLORS = { light: '#FFFFFF', dark: '#111216' } as const;

/**
 * Keeps the `theme-color` metas (the browser bar, and the installed app's title bar) on the theme
 * chosen in Materia, which can differ from the system's (MOB-01). Before the app loads, index.html
 * picks by `prefers-color-scheme`.
 */
@Injectable({ providedIn: 'root' })
export class ThemeColor {
  private readonly document = inject(DOCUMENT);
  private readonly theme = inject(ThemeService);

  constructor() {
    effect(() => {
      const color = THEME_COLORS[this.theme.resolved()];
      for (const meta of this.document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
        meta.setAttribute('content', color);
      }
    });
  }
}
