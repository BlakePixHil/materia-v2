import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ThemeService } from '@materia/ui';

import { THEME_COLORS, ThemeColor } from './theme-color';

describe('ThemeColor', () => {
  afterEach(() => {
    for (const meta of TestBed.inject(DOCUMENT).querySelectorAll('meta[name="theme-color"]')) meta.remove();
    TestBed.resetTestingModule();
  });

  it('keeps the browser bar on the theme chosen in Materia', () => {
    const document = TestBed.inject(DOCUMENT);
    for (const media of ['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)']) {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.media = media;
      document.head.append(meta);
    }
    const theme = TestBed.inject(ThemeService);
    theme.setTheme('dark');
    TestBed.inject(ThemeColor);
    TestBed.tick();
    const colors = () =>
      [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content'));
    expect(colors()).toEqual([THEME_COLORS.dark, THEME_COLORS.dark]);

    theme.setTheme('light');
    TestBed.tick();
    expect(colors()).toEqual([THEME_COLORS.light, THEME_COLORS.light]);
  });
});
