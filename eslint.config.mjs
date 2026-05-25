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
      'dist/**',
      'build/**',
      '.odin-sdk/**',
      '**/*.wasm',
      'web/frontend/public/**',
      'students_workfolder/**',
      'mmt-trade/**',
      'packages/engine/vendor/**',
      'packages/engine/.emsdk/**',
      'packages/engine/build/**',
      'packages/shell/public/**',
      'scripts/replay-audit-transcript.mjs',
      'scripts/replay-audit-report.json',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        crossOriginIsolated: 'readonly',
        Transferable: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslintPlugin,
    },
    rules: {
      'no-unused-vars': 'off',
      ...sharedTypescriptRules,
    },
  },
  {
    files: ['**/*.vue'],
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
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        crossOriginIsolated: 'readonly',
        Transferable: 'readonly',
      },
    },
    plugins: {
      vue: vuePlugin,
      '@typescript-eslint': typescriptEslintPlugin,
    },
    rules: {
      ...vuePlugin.configs['vue3-recommended'].rules,
      'no-unused-vars': 'off',
      ...sharedTypescriptRules,
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: ['**/workers/**/*.ts', 'web/frontend/src/engine/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
        Transferable: 'readonly',
        MessagePort: 'readonly',
        ImageBitmap: 'readonly',
      },
    },
  },
  {
    files: ['packages/shell/**/*.{ts,js,mjs}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        crossOriginIsolated: 'readonly',
      },
    },
  },
  {
    files: ['packages/monitor/**/*.{ts,js,mjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // Node.js globals used in backend and scripts.
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        WebSocket: 'readonly',
        structuredClone: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'max-lines': ['warn', { max: 1600, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['web/frontend/src/widgets/ChartWidget.vue', 'web/backend/index.js'],
    rules: {
      'max-lines': ['warn', { max: 1700, skipBlankLines: true, skipComments: true }],
    },
  },
];
