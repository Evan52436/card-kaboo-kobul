import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * ESLint 9 flat config.
 *
 * `eslint-config-next@16` exports flat configs directly, so this does NOT go
 * through `FlatCompat` — that path is incompatible with ESLint 9.39 and dies
 * with "Converting circular structure to JSON" while formatting its own error.
 * Importing the config files themselves is what Next.js documents for v16.
 */
const config = [
  {
    ignores: ['.next/**', 'out/**', 'build/**', 'node_modules/**', 'next-env.d.ts'],
  },
  ...nextTypescript,
  ...nextCoreWebVitals,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // This is an App Router project with no `pages/` directory, so the rule has
      // nothing to resolve and the plugin only warns that it cannot find one.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
];

export default config;
