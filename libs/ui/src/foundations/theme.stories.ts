import { Component, inject } from '@angular/core';
import type { Meta, StoryObj } from '@storybook/angular';
import { expect, userEvent } from 'storybook/test';

import { MtIcon } from '../lib/icon/icon';
import { ThemeService, type ThemePreference } from '../lib/theme/theme.service';

/** The same card in both themes side by side, plus the ThemeService switch. */
@Component({
  selector: 'mt-theme-demo',
  imports: [MtIcon],
  template: `
    <div class="fd">
      <div class="fd-pair">
        @for (mode of modes; track mode) {
          <div class="fd-panel" [attr.data-theme]="mode">
            <span class="eyebrow t-2">{{ mode }}</span>
            <div class="fd-card">
              <div class="mt-row">
                <mt-icon name="matters" />
                <span class="title-m">Estate of Margaret Whitfield</span>
              </div>
              <span class="body t-2">Probate · Grant of representation due 14 Mar 2026</span>
              <div class="mt-row">
                <span class="label t-brand">Brand text</span>
                <span class="label t-ai">Clerk</span>
                <span class="label t-success">On track</span>
                <span class="label t-danger">Overdue</span>
              </div>
            </div>
          </div>
        }
      </div>
      <div class="mt-row" role="radiogroup" aria-label="Theme">
        @for (choice of choices; track choice) {
          <button
            type="button"
            role="radio"
            class="label"
            [attr.aria-checked]="theme.theme() === choice"
            (click)="theme.setTheme(choice)"
          >
            {{ choice }}
          </button>
        }
        <span class="body t-2">Resolved: {{ theme.resolved() }}</span>
      </div>
    </div>
  `,
})
class ThemeDemo {
  protected readonly theme = inject(ThemeService);
  protected readonly modes = ['light', 'dark'] as const;
  protected readonly choices: ThemePreference[] = ['system', 'light', 'dark'];
}

const meta: Meta<ThemeDemo> = {
  title: 'Foundations/Theme',
  component: ThemeDemo,
};
export default meta;

export const Theme: StoryObj<ThemeDemo> = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole('radio', { name: 'dark' }));
    await expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await userEvent.click(canvas.getByRole('radio', { name: 'light' }));
    await expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  },
};
