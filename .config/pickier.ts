import type { PickierOptions } from 'pickier'

const config: PickierOptions = {
  ignores: [
    '**/CHANGELOG.md',
  ],

  rules: {
    noConsole: 'off',
  },

  pluginRules: {
    'style/brace-style': 'off',
    'style/max-statements-per-line': 'off',
    'pickier/prefer-template': 'off',
    'publint/file-does-not-exist': 'off',
    'markdown/no-space-in-emphasis': 'off',
    'markdown/link-image-style': 'off',
    'markdown/no-emphasis-as-heading': 'off',
    'markdown/no-trailing-punctuation': 'off',
    'markdown/heading-increment': 'off',
    'markdown/descriptive-link-text': 'off',
    'markdown/blanks-around-lists': 'off',
  },
}

export default config
