import path from 'node:path'
import { fileURLToPath } from 'node:url'

import js from '@eslint/js'
import importPlugin from 'eslint-plugin-import'
import obsidianmd from 'eslint-plugin-obsidianmd'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tsFiles = ['**/*.{ts,tsx}']

const commonRules = {
  'react/react-in-jsx-scope': 'off',
  'react/prop-types': 'off',
  'import/no-unresolved': 'off',
  'sort-imports': [
    'error',
    {
      ignoreCase: false,
      ignoreDeclarationSort: true,
      ignoreMemberSort: false,
      memberSyntaxSortOrder: ['none', 'all', 'multiple', 'single'],
      allowSeparatedGroups: true,
    },
  ],
  'import/order': [
    'error',
    {
      'newlines-between': 'always',
      alphabetize: {
        order: 'asc',
        caseInsensitive: true,
      },
    },
  ],
}

const typescriptRuleOverrides = {
  '@typescript-eslint/no-empty-function': 'off',
  '@typescript-eslint/require-await': 'off',
  '@typescript-eslint/consistent-type-definitions': ['warn', 'type'],
  '@typescript-eslint/no-extraneous-class': 'off',
  '@typescript-eslint/no-unsafe-assignment': 'off',
  '@typescript-eslint/no-unsafe-member-access': 'off',
  '@typescript-eslint/no-unsafe-call': 'off',
  '@typescript-eslint/no-useless-constructor': 'off',
  '@typescript-eslint/no-floating-promises': 'off',
  '@typescript-eslint/no-unnecessary-condition': 'off',
  '@typescript-eslint/no-misused-promises': 'off',
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-unsafe-argument': 'off',
  '@typescript-eslint/no-unsafe-return': 'off',
  '@typescript-eslint/no-non-null-assertion': 'off',
  '@typescript-eslint/prefer-nullish-coalescing': 'off',
  '@typescript-eslint/restrict-template-expressions': 'off',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
}

const typedConfigs = [
  ...tseslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.recommendedTypeChecked,
].map((config) => ({
  ...config,
  files: tsFiles,
}))

export default tseslint.config(
  js.configs.recommended,
  ...obsidianmd.configs.recommendedWithLocalesEn,
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      import: importPlugin,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: commonRules,
  },
  ...typedConfigs,
  {
    files: tsFiles,
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: typescriptRuleOverrides,
  },
  {
    ignores: [
      '.DS_Store',
      '.env',
      '.env*.local',
      '.eslintrc.js',
      '.idea',
      '.nyc_output',
      '.obsidian',
      '.project',
      '.settings',
      '.vscode/*',
      '*.launch',
      '*.log',
      '*.md',
      '*.sublime-workspace',
      'c9/',
      'compile-migration.js',
      'coverage',
      'esbuild.config.mjs',
      'import-meta-url-shim.js',
      'jest.config.js',
      'lerna-debug.log*',
      'logs',
      'main.js',
      'manifest.json',
      'node_modules',
      'npm-debug.log*',
      'package.json',
      'pnpm-debug.log*',
      'vendor',
      'version-bump.mjs',
      'versions.json',
      'yarn-debug.log*',
      'yarn-error.log*',
    ],
  },
)
