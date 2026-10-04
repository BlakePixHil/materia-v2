import nx from '@nx/eslint-plugin';

import baseConfig from '../../eslint.config.mjs';

export default [
  ...nx.configs['flat/angular'],
  ...nx.configs['flat/angular-template'],
  ...baseConfig,
  {
    files: ['**/*.ts'],
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'mt',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'mt',
          style: 'kebab-case',
        },
      ],
    },
  },
  {
    // Button, IconButton and the menu items use attribute selectors on native hosts
    // (button[mtButton], FND-08/09), so the native <button>/<a> keeps its semantics.
    files: [
      '**/lib/button/button.ts',
      '**/lib/icon-button/icon-button.ts',
      '**/lib/menu/menu.ts',
      '**/lib/tabs/tabs.ts',
      '**/lib/nav/nav.ts',
    ],
    rules: { '@angular-eslint/component-selector': 'off' },
  },
  {
    files: ['**/*.html'],
    rules: {
      // Checkbox, Switch and Radio render ng-primitives buttons inside their <label> (FND-08).
      '@angular-eslint/template/label-has-associated-control': ['error', { controlComponents: ['button'] }],
      // Icon-only controls are named by aria-labelledby or MtIconButton's required `label`.
      '@angular-eslint/template/elements-content': ['error', { allowList: ['aria-labelledby', 'label'] }],
    },
  },
];
