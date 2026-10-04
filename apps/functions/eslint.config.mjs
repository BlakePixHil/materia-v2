import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.ts'],
    // Log through core/log.ts (structured and redacted), never the console (FND-15).
    rules: { 'no-console': 'error' },
  },
];
