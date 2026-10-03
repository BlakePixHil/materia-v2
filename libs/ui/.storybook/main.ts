import type { StorybookConfig } from '@storybook/angular';

const config: StorybookConfig = {
  stories: ['../**/*.@(mdx|stories.@(js|jsx|ts|tsx))'],
  addons: ['@storybook/addon-a11y'],
  // The Geist fonts live in the web app's public folder (synced by `materia-scripts sync-design`);
  // the token CSS references them at /fonts/.
  staticDirs: [{ from: '../../../apps/web/public/fonts', to: '/fonts' }],
  core: { disableTelemetry: true },
  framework: {
    name: '@storybook/angular',
    options: {
      builder: {
        viteConfigPath: 'libs/ui/vite.config.mts',
      },
    },
  },
};

export default config;
