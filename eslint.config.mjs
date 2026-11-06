import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const NODE_IMPORTS = {
  group: ['node:*'],
  message: 'Node modules are not available in production.',
};

const RESTRICTED_GLOBALS = [
  'error',
  { name: 'Buffer', message: 'Worker and browser code must use Web APIs.' },
  { name: 'process', message: 'Worker and browser code must use validated configuration.' },
  { name: 'require', message: 'Use ES modules.' },
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'dist/',
      '.wrangler/',
      'worker-configuration.d.ts',
      'public/verification-page.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-globals': RESTRICTED_GLOBALS,
      'no-restricted-imports': ['error', { patterns: [NODE_IMPORTS] }],
    },
  },
  {
    files: ['web/**/*.ts', 'shared/**/*.ts'],
    rules: {
      'no-restricted-globals': RESTRICTED_GLOBALS,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            NODE_IMPORTS,
            {
              group: ['**/src/**', 'cloudflare:*'],
              message: 'Browser code cannot import server code.',
            },
          ],
        },
      ],
    },
  },
  { files: ['**/*.mjs'], ...tseslint.configs.disableTypeChecked },
  prettier,
);
