import type { Decorator, Preview } from '@storybook/angular';

/** Sets `data-theme` on <html> from the toolbar, exactly as ThemeService does in the app. */
const withTheme: Decorator = (story, context) => {
  document.documentElement.setAttribute('data-theme', context.globals['theme'] === 'dark' ? 'dark' : 'light');
  return story();
};

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Colour theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light', backgrounds: { value: 'surface' } },
  decorators: [withTheme],
  parameters: {
    // Backgrounds are the token variables, so they follow the theme.
    backgrounds: {
      options: {
        surface: { name: 'Surface', value: 'var(--bg-surface)' },
        canvas: { name: 'Canvas', value: 'var(--bg-canvas)' },
        raised: { name: 'Raised', value: 'var(--bg-raised)' },
      },
    },
    // Accessibility violations fail the story in the test runner, not just warn.
    a11y: { test: 'error' },
    layout: 'padded',
  },
};

export default preview;
