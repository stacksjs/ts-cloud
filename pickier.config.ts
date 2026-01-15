import type { PickierConfig } from 'pickier'

const config: PickierConfig = {
  verbose: false,
  ignores: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/bin/**',
    '**/.git/**',
    '**/coverage/**',
    '**/*.min.js',
    '**/bun.lock',
  ],

  lint: {
    extensions: ['ts', 'js', 'mjs', 'cjs'],
    reporter: 'stylish',
    cache: false,
    maxWarnings: -1,
  },

  format: {
    extensions: ['ts', 'js', 'mjs', 'cjs', 'json', 'md', 'yaml', 'yml'],
    trimTrailingWhitespace: true,
    maxConsecutiveBlankLines: 1,
    finalNewline: 'one',
    indent: 2,
    quotes: 'single',
    semi: false,
  },

  rules: {
    noDebugger: 'error',
    noConsole: 'off',
  },

  pluginRules: {
    // TypeScript rules
    'ts/no-explicit-any': 'off',
    'ts/no-unused-vars': 'warn',

    // General rules
    'general/no-empty': 'warn',

    // Quality rules
    'quality/no-nested-ternary': 'off',

    // Markdown rules
    'markdown/heading-increment': 'error',
    'markdown/no-trailing-spaces': 'error',
    'markdown/fenced-code-language': 'warn',
  },
}

export default config
