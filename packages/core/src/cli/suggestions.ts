/**
 * Command suggestions and typo corrections
 * Helps users discover commands and fix typos
 */

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      }
      else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1, // deletion
        )
      }
    }
  }

  return matrix[b.length][a.length]
}

/**
 * Calculate similarity score between 0 and 1
 */
function similarityScore(a: string, b: string): number {
  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase())
  const maxLength = Math.max(a.length, b.length)

  if (maxLength === 0) return 1

  return 1 - distance / maxLength
}

/**
 * Suggest similar commands based on typo
 */
export function suggestCommand(input: string, availableCommands: string[], threshold = 0.5): string[] {
  const suggestions = availableCommands
    .map(cmd => ({
      command: cmd,
      score: similarityScore(input, cmd),
    }))
    .filter(item => item.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map(item => item.command)

  return suggestions.slice(0, 5) // Return top 5 suggestions
}

/**
 * Format suggestion message
 */
export function formatSuggestion(input: string, suggestions: string[]): string {
  if (suggestions.length === 0) {
    return `Unknown command: '${input}'\n\nRun 'ts-cloud --help' to see available commands.`
  }

  if (suggestions.length === 1) {
    return `Unknown command: '${input}'\n\nDid you mean: ${suggestions[0]}?`
  }

  return `Unknown command: '${input}'\n\nDid you mean one of these?\n${suggestions.map(s => `  • ${s}`).join('\n')}`
}

/**
 * Check if input is likely a typo of any available command
 */
export function isLikelyTypo(input: string, availableCommands: string[]): boolean {
  return suggestCommand(input, availableCommands, 0.7).length > 0
}

/**
 * Command categories for contextual help
 */
export interface CommandCategory {
  name: string
  description: string
  commands: CommandInfo[]
}

export interface CommandInfo {
  name: string
  description: string
  aliases?: string[]
  examples?: string[]
}

/**
 * Get contextual help based on current command
 */
export function getContextualHelp(
  currentCommand: string,
  categories: CommandCategory[],
): string {
  // Find the category containing the current command
  const category = categories.find(cat =>
    cat.commands.some(cmd => cmd.name === currentCommand || cmd.aliases?.includes(currentCommand)),
  )

  if (!category) {
    return 'No contextual help available.'
  }

  const lines: string[] = []

  lines.push(`${category.name}`)
  lines.push('─'.repeat(category.name.length))
  lines.push(category.description)
  lines.push('')

  // Show related commands
  lines.push('Related commands:')
  for (const cmd of category.commands) {
    lines.push(`  ${cmd.name.padEnd(20)} ${cmd.description}`)

    if (cmd.aliases && cmd.aliases.length > 0) {
      lines.push(`    Aliases: ${cmd.aliases.join(', ')}`)
    }
  }

  // Show examples for current command
  const currentCmd = category.commands.find(
    cmd => cmd.name === currentCommand || cmd.aliases?.includes(currentCommand),
  )

  if (currentCmd?.examples && currentCmd.examples.length > 0) {
    lines.push('')
    lines.push('Examples:')
    for (const example of currentCmd.examples) {
      lines.push(`  ${example}`)
    }
  }

  return lines.join('\n')
}

/**
 * Search commands by keyword
 */
export function searchCommands(
  query: string,
  categories: CommandCategory[],
): Array<{ command: CommandInfo; category: string }> {
  const results: Array<{ command: CommandInfo; category: string }> = []
  const queryLower = query.toLowerCase()

  for (const category of categories) {
    for (const command of category.commands) {
      const nameMatch = command.name.toLowerCase().includes(queryLower)
      const descMatch = command.description.toLowerCase().includes(queryLower)
      const aliasMatch = command.aliases?.some(alias => alias.toLowerCase().includes(queryLower))

      if (nameMatch || descMatch || aliasMatch) {
        results.push({
          command,
          category: category.name,
        })
      }
    }
  }

  return results
}

/**
 * Autocomplete suggestions for partial input
 */
export function autocomplete(
  partial: string,
  availableCommands: string[],
  maxResults = 10,
): string[] {
  const partialLower = partial.toLowerCase()

  // First, exact prefix matches
  const prefixMatches = availableCommands.filter(cmd =>
    cmd.toLowerCase().startsWith(partialLower),
  )

  // Then, contains matches
  const containsMatches = availableCommands.filter(
    cmd =>
      cmd.toLowerCase().includes(partialLower) && !cmd.toLowerCase().startsWith(partialLower),
  )

  return [...prefixMatches, ...containsMatches].slice(0, maxResults)
}

/**
 * Suggest flags based on partial input
 */
export interface FlagInfo {
  name: string
  alias?: string
  description: string
  type: 'boolean' | 'string' | 'number'
  required?: boolean
}

export function suggestFlags(partial: string, availableFlags: FlagInfo[]): FlagInfo[] {
  const partialLower = partial.toLowerCase()

  return availableFlags.filter((flag) => {
    const nameMatch = flag.name.toLowerCase().includes(partialLower)
    const aliasMatch = flag.alias?.toLowerCase().includes(partialLower)

    return nameMatch || aliasMatch
  })
}

/**
 * Format flag suggestions
 */
export function formatFlagSuggestions(flags: FlagInfo[]): string {
  if (flags.length === 0) {
    return 'No matching flags found.'
  }

  const lines: string[] = []

  for (const flag of flags) {
    let line = `  --${flag.name}`

    if (flag.alias) {
      line += `, -${flag.alias}`
    }

    line = line.padEnd(30)
    line += flag.description

    if (flag.required) {
      line += ' (required)'
    }

    lines.push(line)
  }

  return lines.join('\n')
}

/**
 * Get command usage example
 */
export function getCommandUsage(command: CommandInfo): string {
  const lines: string[] = []

  lines.push(`Usage: ts-cloud ${command.name}`)
  lines.push('')
  lines.push(command.description)

  if (command.aliases && command.aliases.length > 0) {
    lines.push('')
    lines.push(`Aliases: ${command.aliases.join(', ')}`)
  }

  if (command.examples && command.examples.length > 0) {
    lines.push('')
    lines.push('Examples:')
    for (const example of command.examples) {
      lines.push(`  ${example}`)
    }
  }

  return lines.join('\n')
}

/**
 * Validate command and suggest fixes
 */
export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  suggestions: string[]
}

export function validateCommand(
  input: string,
  availableCommands: string[],
  requiredFlags: string[] = [],
): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    suggestions: [],
  }

  const [command, ...args] = input.split(' ')

  // Check if command exists
  if (!availableCommands.includes(command)) {
    result.valid = false
    result.errors.push(`Unknown command: ${command}`)

    const suggestions = suggestCommand(command, availableCommands)
    if (suggestions.length > 0) {
      result.suggestions.push(...suggestions)
    }
  }

  // Check for required flags
  for (const flag of requiredFlags) {
    if (!args.some(arg => arg === `--${flag}` || arg.startsWith(`--${flag}=`))) {
      result.valid = false
      result.errors.push(`Missing required flag: --${flag}`)
    }
  }

  return result
}
