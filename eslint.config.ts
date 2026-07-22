import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'prettier.config.cjs',
      'src-tauri/target/**',
      'src-tauri/gen/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: ['src/composables/**/*.ts', 'src/services/**/*.ts', 'src/repositories/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/**', '@/pages/**', '@/infrastructure/**'],
              message: 'Application modules must depend on ports/models, not UI or adapters.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/models/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'vue',
                '@tauri-apps/**',
                '@/composables/**',
                '@/features/**',
                '@/infrastructure/**',
                '@/pages/**',
                '@/repositories/**',
                '@/services/**',
              ],
              message: 'Domain models must remain framework and infrastructure independent.',
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
)
