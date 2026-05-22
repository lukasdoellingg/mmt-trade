import js from '@eslint/js';
import globals from 'globals';
import typescriptEslintPlugin from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import vuePlugin from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

const sharedTypescriptRules = {
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
};

export default [
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'dist/**',
      '**/dist/**',
      'build/**',
      '**/build/**',
      '.odin-sdk/**',
      '**/*.wasm',
      'web/frontend/public/**',
      'web/legacy-frontend/**',
      'packages/shell/public/**',
      'students_workfolder/**',
      'mmt-trade/**',
      'packages/engine/vendor/**',
      'packages/engine/.emsdk/**',
      'packages/engine/build/**',
      'scripts/debug-wasm-abort.mjs',
    ],
  },
  {
    ...js.configs.recommended,
    files: ['**/*.{js,mjs,cjs}'],
    ignores: ['web/frontend/**', 'packages/shell/**', 'packages/engine/.emsdk/**'],
  },
  {
    files: ['web/frontend/**/*.{ts,tsx,vue}', 'packages/shell/**/*.{ts,tsx}'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslintPlugin,
    },
    rules: {
      ...sharedTypescriptRules,
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['web/frontend/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: typescriptParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    plugins: {
      vue: vuePlugin,
      '@typescript-eslint': typescriptEslintPlugin,
    },
    rules: {
      ...vuePlugin.configs['vue3-recommended'].rules,
      ...sharedTypescriptRules,
      'no-unused-vars': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/attributes-order': 'off',
    },
  },
  {
    files: ['web/frontend/src/workers/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.worker,
        ...globals.es2021,
      },
    },
  },
  {
    files: ['packages/shell/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    rules: {
      ...sharedTypescriptRules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ignores: ['web/frontend/**', 'packages/shell/**', 'packages/engine/.emsdk/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['tests/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['playwright.config.ts', 'tests/e2e/**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslintPlugin,
    },
    rules: {
      ...sharedTypescriptRules,
      'no-unused-vars': 'off',
    },
  },
];
