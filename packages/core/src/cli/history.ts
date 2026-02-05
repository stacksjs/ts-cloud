/**
 * Command history with search and persistence
 * Tracks executed commands and provides search/replay functionality
 */

export interface HistoryEntry {
  command: string
  timestamp: Date
  success: boolean
  duration?: number
  output?: string
}

export interface HistoryOptions {
  maxSize?: number
  persistFile?: string
  trackOutput?: boolean
}

/**
 * Command history manager
 */
export class CommandHistory {
  private entries: HistoryEntry[] = []
  private maxSize: number
  private persistFile?: string
  private trackOutput: boolean

  constructor(options: HistoryOptions = {}) {
    this.maxSize = options.maxSize || 1000
    this.persistFile = options.persistFile
    this.trackOutput = options.trackOutput || false
  }

  /**
   * Add command to history
   */
  add(entry: Omit<HistoryEntry, 'timestamp'>): void {
    this.entries.push({
      ...entry,
      timestamp: new Date(),
    })

    // Trim if exceeds max size
    if (this.entries.length > this.maxSize) {
      this.entries = this.entries.slice(-this.maxSize)
    }
  }

  /**
   * Get all history entries
   */
  getAll(): HistoryEntry[] {
    return [...this.entries]
  }

  /**
   * Get recent entries
   */
  getRecent(count: number = 10): HistoryEntry[] {
    return this.entries.slice(-count)
  }

  /**
   * Search history by command text
   */
  search(query: string): HistoryEntry[] {
    const lowerQuery = query.toLowerCase()

    return this.entries.filter(entry =>
      entry.command.toLowerCase().includes(lowerQuery),
    )
  }

  /**
   * Search history by date range
   */
  searchByDate(startDate: Date, endDate: Date): HistoryEntry[] {
    return this.entries.filter(
      entry => entry.timestamp >= startDate && entry.timestamp <= endDate,
    )
  }

  /**
   * Get successful commands
   */
  getSuccessful(): HistoryEntry[] {
    return this.entries.filter(entry => entry.success)
  }

  /**
   * Get failed commands
   */
  getFailed(): HistoryEntry[] {
    return this.entries.filter(entry => !entry.success)
  }

  /**
   * Get most used commands
   */
  getMostUsed(count: number = 10): Array<{ command: string; count: number }> {
    const commandCounts: Map<string, number> = new Map()

    for (const entry of this.entries) {
      const baseCommand = entry.command.split(' ')[0]
      commandCounts.set(baseCommand, (commandCounts.get(baseCommand) || 0) + 1)
    }

    return Array.from(commandCounts.entries())
      .map(([command, count]) => ({ command, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, count)
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number
    successful: number
    failed: number
    averageDuration: number
    mostUsed: string
  } {
    const total = this.entries.length
    const successful = this.entries.filter(e => e.success).length
    const failed = this.entries.filter(e => !e.success).length

    const durationsWithValue = this.entries.filter(e => e.duration !== undefined)
    const averageDuration = durationsWithValue.length > 0
      ? durationsWithValue.reduce((sum, e) => sum + (e.duration || 0), 0) / durationsWithValue.length
      : 0

    const mostUsedList = this.getMostUsed(1)
    const mostUsed = mostUsedList.length > 0 ? mostUsedList[0].command : 'N/A'

    return {
      total,
      successful,
      failed,
      averageDuration,
      mostUsed,
    }
  }

  /**
   * Clear history
   */
  clear(): void {
    this.entries = []
  }

  /**
   * Get entry by index
   */
  getByIndex(index: number): HistoryEntry | undefined {
    if (index < 0 || index >= this.entries.length) {
      return undefined
    }
    return this.entries[index]
  }

  /**
   * Remove entry by index
   */
  removeByIndex(index: number): void {
    if (index >= 0 && index < this.entries.length) {
      this.entries.splice(index, 1)
    }
  }

  /**
   * Save history to file
   */
  async save(): Promise<void> {
    if (!this.persistFile) return

    try {
      const fs = await import('node:fs/promises')
      const data = JSON.stringify(this.entries, null, 2)
      await fs.writeFile(this.persistFile, data, 'utf-8')
    }
    catch (error) {
      throw new Error(`Failed to save history: ${error}`)
    }
  }

  /**
   * Load history from file
   */
  async load(): Promise<void> {
    if (!this.persistFile) return

    try {
      const fs = await import('node:fs/promises')
      const data = await fs.readFile(this.persistFile, 'utf-8')
      const parsed = JSON.parse(data)

      this.entries = parsed.map((entry: any) => ({
        ...entry,
        timestamp: new Date(entry.timestamp),
      }))
    }
    catch {
      // File doesn't exist or can't be read - that's ok
      this.entries = []
    }
  }

  /**
   * Export history as JSON
   */
  exportJSON(): string {
    return JSON.stringify(this.entries, null, 2)
  }

  /**
   * Export history as CSV
   */
  exportCSV(): string {
    const header = 'Timestamp,Command,Success,Duration'
    const rows = this.entries.map(entry =>
      [
        entry.timestamp.toISOString(),
        `"${entry.command.replace(/"/g, '""')}"`, // Escape quotes
        entry.success,
        entry.duration || '',
      ].join(','),
    )

    return [header, ...rows].join('\n')
  }

  /**
   * Import history from JSON
   */
  importJSON(json: string): void {
    const parsed = JSON.parse(json)

    const imported = parsed.map((entry: any) => ({
      ...entry,
      timestamp: new Date(entry.timestamp),
    }))

    this.entries.push(...imported)

    // Trim if exceeds max size
    if (this.entries.length > this.maxSize) {
      this.entries = this.entries.slice(-this.maxSize)
    }
  }

  /**
   * Get history grouped by date
   */
  groupByDate(): Map<string, HistoryEntry[]> {
    const grouped: Map<string, HistoryEntry[]> = new Map()

    for (const entry of this.entries) {
      const dateKey = entry.timestamp.toISOString().split('T')[0]

      if (!grouped.has(dateKey)) {
        grouped.set(dateKey, [])
      }

      grouped.get(dateKey)!.push(entry)
    }

    return grouped
  }

  /**
   * Get history grouped by command
   */
  groupByCommand(): Map<string, HistoryEntry[]> {
    const grouped: Map<string, HistoryEntry[]> = new Map()

    for (const entry of this.entries) {
      const baseCommand = entry.command.split(' ')[0]

      if (!grouped.has(baseCommand)) {
        grouped.set(baseCommand, [])
      }

      grouped.get(baseCommand)!.push(entry)
    }

    return grouped
  }

  /**
   * Replay a command from history
   */
  replay(index: number): string | undefined {
    const entry = this.getByIndex(index)
    return entry?.command
  }

  /**
   * Get suggestions based on partial input
   */
  getSuggestions(partial: string, limit: number = 5): string[] {
    const lowerPartial = partial.toLowerCase()

    // Find commands that start with the partial
    const matches = this.entries
      .filter(entry => entry.command.toLowerCase().startsWith(lowerPartial))
      .map(entry => entry.command)

    // Remove duplicates and limit
    return [...new Set(matches)].slice(0, limit)
  }

  /**
   * Analyze command patterns
   */
  analyzePatterns(): {
    timeOfDay: Map<number, number> // hour -> count
    dayOfWeek: Map<number, number> // day -> count
    successRate: number
  } {
    const timeOfDay: Map<number, number> = new Map()
    const dayOfWeek: Map<number, number> = new Map()

    for (const entry of this.entries) {
      const hour = entry.timestamp.getHours()
      const day = entry.timestamp.getDay()

      timeOfDay.set(hour, (timeOfDay.get(hour) || 0) + 1)
      dayOfWeek.set(day, (dayOfWeek.get(day) || 0) + 1)
    }

    const successRate = this.entries.length > 0
      ? this.getSuccessful().length / this.entries.length
      : 0

    return {
      timeOfDay,
      dayOfWeek,
      successRate,
    }
  }
}

/**
 * Format history for display
 */
export function formatHistory(entries: HistoryEntry[], options: { maxWidth?: number } = {}): string {
  const { maxWidth = 100 } = options

  if (entries.length === 0) {
    return 'No command history'
  }

  const lines: string[] = []

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const index = (i + 1).toString().padStart(4)
    const timestamp = entry.timestamp.toLocaleString()
    const status = entry.success ? '✓' : '✗'

    let command = entry.command
    if (command.length > maxWidth - 30) {
      command = command.substring(0, maxWidth - 33) + '...'
    }

    let line = `${index}  ${timestamp}  ${status}  ${command}`

    if (entry.duration) {
      line += `  (${entry.duration}ms)`
    }

    lines.push(line)
  }

  return lines.join('\n')
}

/**
 * Format history statistics
 */
export function formatHistoryStats(stats: ReturnType<CommandHistory['getStats']>): string {
  const lines: string[] = []

  lines.push('Command History Statistics')
  lines.push('─'.repeat(30))
  lines.push(`Total commands:     ${stats.total}`)
  lines.push(`Successful:         ${stats.successful}`)
  lines.push(`Failed:             ${stats.failed}`)
  lines.push(`Success rate:       ${((stats.successful / stats.total) * 100).toFixed(1)}%`)
  lines.push(`Average duration:   ${stats.averageDuration.toFixed(0)}ms`)
  lines.push(`Most used:          ${stats.mostUsed}`)

  return lines.join('\n')
}
