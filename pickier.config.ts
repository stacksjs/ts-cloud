export default {
  ignores: [
    '**/node_modules/**',
    '**/.pnpm/**',
    '**/.yarn/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/.output/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.vite/**',
    '**/.turbo/**',
    '**/.cache/**',
    '**/coverage/**',
    '**/vendor/**',
    '**/pantry/**',
    '**/tmp/**',
    '**/.git/**',
    '**/.idea/**',
    '**/.vscode/**',
    '**/.zed/**',
    '**/.cursor/**',
    '**/.claude/**',
    '**/.github/**',
    '**/*.test.ts',
    '**/*.spec.ts',
    '**/.bunpress/**',
    '**/.vitepress/cache/**',
    '**/*.lock',
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/CHANGELOG.md',
  ],
  lint: {
    extensions: ['ts', 'js', 'html', 'css', 'json', 'jsonc', 'md', 'yaml', 'yml', 'stx', 'sh', 'bash', 'zsh'],
    reporter: 'stylish',
    cache: false,
    maxWarnings: 0,
  },
  format: {
    // Preserve parser-aware indentation while Pickier normalizes the rest.
    preserveCodeIndentation: true,
  },
  rules: {
    noConsole: 'off',
  },
  pluginRules: {
    'markdown/no-duplicate-heading': 'off',
    'markdown/link-image-style': 'off',
    // Pickier 0.1.40 counts TypeScript type-member semicolons as statements.
    'style/max-statements-per-line': 'off',
    // Keep the formatter-compatible one-true-brace style (`} else`).
    'style/brace-style': 'off',
    // Concatenation remains clearer for generated protocol/configuration text.
    'pickier/prefer-template': 'off',
  },
}
