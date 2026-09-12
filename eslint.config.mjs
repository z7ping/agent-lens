import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const ignored = [
  '**/node_modules/**',
  '**/dist/**',
  '**/release/**',
  'apps/desktop/runtime/**',
  '**/.electron-dist/**',
  '**/coverage/**',
]

export default tseslint.config(
  { ignores: ignored },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
    rules: {
      'no-constant-condition': 'error',
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['**/*.{ts,tsx,mts,cts}'],
  })),
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      globals: {
        ...globals.nodeBuiltin,
        ...globals.browser,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-duplicate-imports': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    plugins: reactHooks.configs.flat.recommended.plugins,
    rules: reactHooks.configs.flat.recommended.rules,
  },
)
