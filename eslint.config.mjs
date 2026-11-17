import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/generated/**',
      'docs/**',
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // CLAUDE.md: no `any`, use `unknown` + narrowing
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // NestJS injects dependencies from constructor parameter types, so those imports must
    // stay value imports; `import type` would erase them and break DI at runtime.
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    // Browser code (the two web apps and the shared kit). `.vue` files go through
    // vue-eslint-parser, which hands <script lang="ts"> to typescript-eslint.
    files: [
      'apps/staff/**/*.{ts,vue}',
      'apps/customer/**/*.{ts,vue}',
      'packages/web-core/**/*.{ts,vue}',
    ],
    languageOptions: {
      globals: { ...globals.browser },
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        sourceType: 'module',
      },
    },
    rules: {
      // CLAUDE.md: no hardcoded user-facing strings, every text goes through vue-i18n.
      'vue/no-bare-strings-in-template': [
        'error',
        {
          allowlist: [
            '(',
            ')',
            ',',
            '.',
            '&',
            '+',
            '-',
            '=',
            '*',
            '/',
            '#',
            '%',
            '!',
            '?',
            ':',
            '[',
            ']',
            '{',
            '}',
            '<',
            '>',
            '|',
            '·',
            '•',
            '—',
            '→',
            '…',
          ],
        },
      ],
      // UI kit components are deliberately single-word (Button, Card, Modal, ...).
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    // Hard rule 7: cost contracts (key names, cost route paths) and the staff order contracts
    // (accounting vocabulary, staff DTOs, staff routes) must not reach the customer bundle. Only
    // the staff area of the web app may import the staff-cost and staff-orders entries; everything
    // else in apps/staff (router, services, shared screens) and the shared kit may not.
    files: ['apps/staff/**/*.{ts,vue}', 'packages/web-core/**/*.{ts,vue}'],
    // Staff-only features: the staff-* folders (staff-orders, staff-cost, staff-shell), pricing and
    // catalog (lazy staff route group; the bundle check guards it), and the command palette (only
    // opened by staff). Pricing, catalog and search may use the cost entry but NOT the order entry
    // (second block below); the order entry belongs to apps/staff/src/features/staff*/ alone.
    ignores: [
      'apps/staff/src/features/staff*/**',
      'apps/staff/src/features/pricing/**',
      'apps/staff/src/features/catalog/**',
      'apps/staff/src/features/search/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@iorder/shared/staff-cost', '@iorder/shared/staff-cost/*'],
              message:
                'Cost contracts are staff-only: import @iorder/shared/staff-cost only from apps/staff/src/features/staff*/.',
            },
            {
              group: ['@iorder/shared/staff-auth', '@iorder/shared/staff-auth/*'],
              message:
                'Staff sign-in contracts are staff-only: import @iorder/shared/staff-auth only from apps/staff/src/features/staff*/.',
            },
            {
              group: ['@iorder/shared/staff-orders', '@iorder/shared/staff-orders/*'],
              message:
                'Staff order contracts are staff-only: import @iorder/shared/staff-orders only from apps/staff/src/features/staff*/.',
            },
          ],
        },
      ],
    },
  },
  {
    // Pricing, catalog and search may import the cost entry, but the staff order entry belongs to
    // apps/staff/src/features/staff*/ only.
    files: [
      'apps/staff/src/features/pricing/**/*.{ts,vue}',
      'apps/staff/src/features/catalog/**/*.{ts,vue}',
      'apps/staff/src/features/search/**/*.{ts,vue}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@iorder/shared/staff-auth', '@iorder/shared/staff-auth/*'],
              message:
                'Staff sign-in contracts are staff-only: import @iorder/shared/staff-auth only from apps/staff/src/features/staff*/.',
            },
            {
              group: ['@iorder/shared/staff-orders', '@iorder/shared/staff-orders/*'],
              message:
                'Staff order contracts are staff-only: import @iorder/shared/staff-orders only from apps/staff/src/features/staff*/.',
            },
          ],
        },
      ],
    },
  },
  {
    // The shared kit is used by every app, so it never reaches into one: no `@/` (an app's own
    // source) import.
    files: ['packages/web-core/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/*'],
              message: 'web-core is shared by the apps: it must not import app code (@/...).',
            },
            {
              group: ['@iorder/shared/staff-cost', '@iorder/shared/staff-cost/*'],
              message: 'Cost contracts are staff-only and never belong in the shared kit.',
            },
            {
              group: ['@iorder/shared/staff-auth', '@iorder/shared/staff-auth/*'],
              message: 'Staff sign-in contracts are staff-only and never belong in the shared kit.',
            },
            {
              group: ['@iorder/shared/staff-orders', '@iorder/shared/staff-orders/*'],
              message: 'Staff order contracts are staff-only and never belong in the shared kit.',
            },
          ],
        },
      ],
    },
  },
  {
    // Hard rule 7: the customer app never sees a staff contract (cost, staff sign-in, staff
    // orders), and it shares code with the staff app only through web-core.
    files: ['apps/customer/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@iorder/shared/staff-cost', '@iorder/shared/staff-cost/*'],
              message: 'Cost contracts are staff-only: the customer app never imports them.',
            },
            {
              group: ['@iorder/shared/staff-auth', '@iorder/shared/staff-auth/*'],
              message:
                'Staff sign-in contracts are staff-only: the customer app never imports them.',
            },
            {
              group: ['@iorder/shared/staff-orders', '@iorder/shared/staff-orders/*'],
              message: 'Staff order contracts are staff-only: the customer app never imports them.',
            },
            {
              group: ['**/apps/staff/**', '**/staff/src/**'],
              message: 'Share code through packages/web-core, never by importing the staff app.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
