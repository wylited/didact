// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/vendor/**',
      'apps/site/public/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    // prefer-const is a stylistic rule; this repo bans stylistic rules.
    // `_`-prefixed args are intentional "acknowledged, unused" markers
    // (e.g. kernels ignoring the breakpoints argument).
    rules: {
      'prefer-const': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
