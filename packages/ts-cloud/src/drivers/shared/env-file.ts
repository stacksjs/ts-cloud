/**
 * Encode an environment map as a `.env` file body that round-trips correctly
 * through PHP dotenv (Laravel) and Bun's `.env` loader.
 *
 * Values are double-quoted with the standard dotenv escapes (`\\`, `\"`, `\n`,
 * `\r`, `\t`) so secrets/keys containing spaces, `#`, `=`, quotes, backslashes,
 * or newlines survive intact. (The previous `JSON.stringify` approach
 * over-escaped some values and corrupted multi-line ones.)
 */
export function formatEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${quoteEnvValue(String(v))}`)
    .join('\n')
}

/** Double-quote + escape a single `.env` value. */
export function quoteEnvValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}
