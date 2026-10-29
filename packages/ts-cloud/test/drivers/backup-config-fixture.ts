/** Execute the generated TypeScript config to check values, not serialization. */
export function readBackupConfig(source: string): any {
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.replace('export default config', 'return config'))
  return new Function('process', javascript)({ env: {} })
}
