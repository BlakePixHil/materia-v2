import nx from '@nx/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

/**
 * Root ESLint flat config. Projects extend it. The module boundaries below enforce the rules in
 * Architecture & ADRs ("Repository layout"); see docs/01-architecture-and-adrs.md.
 */
export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/vitest.config.*.timestamp*', '**/storybook-static', 'design/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mts', '**/*.mjs'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            // Layering (type:*)
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:ui', 'type:data-access', 'type:domain', 'type:util'],
            },
            // Components are presentational: no data access.
            { sourceTag: 'type:ui', onlyDependOnLibsWithTags: ['type:ui', 'type:domain', 'type:util'] },
            {
              sourceTag: 'type:data-access',
              onlyDependOnLibsWithTags: ['type:data-access', 'type:domain', 'type:util'],
            },
            // domain and deadlines are pure TS: they run in web, functions and tools.
            {
              sourceTag: 'type:domain',
              onlyDependOnLibsWithTags: ['type:domain', 'type:util'],
              bannedExternalImports: [
                '@angular/*',
                'firebase',
                'firebase/*',
                'firebase-admin*',
                'firebase-functions*',
                '@firebase/*',
                'rxjs*',
              ],
            },
            { sourceTag: 'type:util', onlyDependOnLibsWithTags: ['type:domain', 'type:util'] },
            // Runtime boundaries (scope:*)
            { sourceTag: 'scope:web', onlyDependOnLibsWithTags: ['scope:web', 'scope:shared'] },
            { sourceTag: 'scope:functions', onlyDependOnLibsWithTags: ['scope:functions', 'scope:shared'] },
            { sourceTag: 'scope:tools', onlyDependOnLibsWithTags: ['scope:tools', 'scope:shared', 'scope:functions'] },
            { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
            // apps/web features talk to data-access, never to Firestore directly.
            {
              allSourceTags: ['type:app', 'scope:web'],
              onlyDependOnLibsWithTags: ['*'],
              bannedExternalImports: ['firebase/firestore', 'firebase-admin*', 'firebase-functions*'],
            },
          ],
        },
      ],
    },
  },
  // typescript-eslint strict rules for TypeScript sources.
  ...tseslint.configs.strict.map((config) => ({ ...config, files: ['**/*.ts', '**/*.mts', '**/*.cts'] })),
  {
    files: ['**/*.ts'],
    rules: {
      // Angular components and pages are often empty classes carrying a decorator.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  // Clerk (AI-02): every model call goes through ClerkGateway. Model SDKs are imported only by the
  // provider adapters (and the AI-01 latency benchmark). Patterns are relative to each project's
  // config, hence the leading `**/`.
  {
    files: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.js', '**/*.mjs'],
    ignores: ['**/src/clerk/providers/**', '**/src/clerk-bench.ts', '**/src/clerk-bench.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@anthropic-ai/*',
                'openai',
                'openai/*',
                '@google/genai',
                '@google-cloud/vertexai',
                '@aws-sdk/client-bedrock*',
              ],
              message:
                'Call Claude through ClerkGateway (apps/functions/src/clerk). Model SDKs are imported only in apps/functions/src/clerk/providers (AI-02).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.mts', '**/*.js', '**/*.mjs'],
    plugins: { import: importPlugin },
    rules: {
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
          pathGroups: [{ pattern: '@materia/**', group: 'internal' }],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },
];
