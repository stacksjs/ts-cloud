/**
 * Interactive REPL mode for ts-cloud CLI
 * Provides a shell-like experience for running commands
*/

export interface REPLOptions {
  prompt?: string
  welcome?: string
  commands: Map<string, REPLCommand>
  historyFile?: string
  autocomplete?: boolean
}

export interface REPLCommand {
  name: string
  description: string
  aliases?: string[]
  handler: (args: string[]) => Promise<void> | void
  autocomplete?: (partial: string) => string[]
}

export interface REPLHistory {
  commands: string[]
  maxSize: number
}

/**
 * REPL session manager
*/
export class REPL {
  private options: REPLOptions
  private running: boolean = false
  private history: REPLHistory = {
    commands: [],
    maxSize: 1000,
  }
  private historyIndex: number = -1

  constructor(options: REPLOptions) {
    this.options = {
      prompt: options.prompt || '> ',
      welcome: options.welcome || 'Welcome to ts-cloud interactive mode. Type "help" for available commands.',
      ...options,
    }
  }

  /**
   * Start REPL session
  */
  async start(): Promise<void> {
    this.running = true

    // Print welcome message
    if (this.options.welcome) {
      console.log(this.options.welcome)
      console.log('')
    }

    // Load history from file if specified
    if (this.options.historyFile) {
      await this.loadHistory()
    }

    // Main REPL loop
    while (this.running) {
      try {
        const input = await this.readInput()

        if (!input.trim()) continue

        // Add to history
        this.addToHistory(input)

        // Parse and execute command
        await this.executeCommand(input)
      }
      catch (error) {
        if (error instanceof Error) {
          console.error(`Error: ${error.message}`)
        }
      }
    }

    // Save history before exiting
    if (this.options.historyFile) {
      await this.saveHistory()
    }
  }

  /**
   * Stop REPL session
  */
  stop(): void {
    this.running = false
  }

  /**
   * Read input from user
  */
  private async readInput(): Promise<string> {
    // In a real implementation, this would use readline or similar
    // For now, we'll return a mock implementation
    return new Promise((resolve) => {
      // Mock implementation - in real code, use readline
      process.stdout.write(this.options.prompt || '> ')

      // This is a simplified version - real implementation would handle:
      // - Line editing
      // - History navigation (up/down arrows)
      // - Autocomplete (tab)
      // - Ctrl+C handling
      resolve('')
    })
  }

  /**
   * Execute command
  */
  private async executeCommand(input: string): Promise<void> {
    const [commandName, ...args] = this.parseCommand(input)

    // Check for built-in commands
    if (commandName === 'exit' || commandName === 'quit') {
      this.stop()
      return
    }

    if (commandName === 'help') {
      this.showHelp()
      return
    }

    if (commandName === 'history') {
      this.showHistory()
      return
    }

    if (commandName === 'clear') {
      console.clear()
      return
    }

    // Find command (including aliases)
    const command = this.findCommand(commandName)

    if (!command) {
      console.error(`Unknown command: ${commandName}`)
      console.log('Type "help" to see available commands.')
      return
    }

    // Execute command handler
    try {
      await command.handler(args)
    }
    catch (error) {
      if (error instanceof Error) {
        console.error(`Command failed: ${error.message}`)
      }
    }
  }

  /**
   * Parse command input
  */
  private parseCommand(input: string): string[] {
    // Simple parser - could be enhanced to handle:
    // - Quoted strings
    // - Escaped characters
    // - Variable substitution
    return input.trim().split(/\s+/)
  }

  /**
   * Find command by name or alias
  */
  private findCommand(name: string): REPLCommand | undefined {
    for (const [_key, command] of this.options.commands) {
      if (command.name === name || command.aliases?.includes(name)) {
        return command
      }
    }
    return undefined
  }

  /**
   * Show help message
  */
  private showHelp(): void {
    console.log('Available commands:')
    console.log('')

    const commands = Array.from(this.options.commands.values())

    // Built-in commands
    console.log('  help                 Show this help message')
    console.log('  history              Show command history')
    console.log('  clear                Clear screen')
    console.log('  exit, quit           Exit interactive mode')
    console.log('')

    // User commands
    for (const command of commands) {
      let line = `  ${command.name.padEnd(20)} ${command.description}`

      if (command.aliases && command.aliases.length > 0) {
        line += ` (aliases: ${command.aliases.join(', ')})`
      }

      console.log(line)
    }
  }

  /**
   * Show command history
  */
  private showHistory(): void {
    if (this.history.commands.length === 0) {
      console.log('No command history')
      return
    }

    console.log('Command history:')
    this.history.commands.forEach((cmd, index) => {
      console.log(`  ${(index + 1).toString().padStart(4)}  ${cmd}`)
    })
  }

  /**
   * Add command to history
  */
  private addToHistory(command: string): void {
    // Don't add duplicates of the last command
    if (this.history.commands[this.history.commands.length - 1] === command) {
      return
    }

    this.history.commands.push(command)

    // Trim history if it exceeds max size
    if (this.history.commands.length > this.history.maxSize) {
      this.history.commands = this.history.commands.slice(-this.history.maxSize)
    }

    this.historyIndex = this.history.commands.length
  }

  /**
   * Navigate history (up arrow)
  */
  private historyBack(): string | undefined {
    if (this.historyIndex > 0) {
      this.historyIndex--
      return this.history.commands[this.historyIndex]
    }
    return undefined
  }

  /**
   * Navigate history (down arrow)
  */
  private historyForward(): string | undefined {
    if (this.historyIndex < this.history.commands.length - 1) {
      this.historyIndex++
      return this.history.commands[this.historyIndex]
    }
    this.historyIndex = this.history.commands.length
    return ''
  }

  /**
   * Autocomplete command
  */
  private autocomplete(partial: string): string[] {
    const suggestions: string[] = []

    // Check built-in commands
    const builtins = ['help', 'history', 'clear', 'exit', 'quit']
    for (const builtin of builtins) {
      if (builtin.startsWith(partial)) {
        suggestions.push(builtin)
      }
    }

    // Check user commands
    for (const [_key, command] of this.options.commands) {
      if (command.name.startsWith(partial)) {
        suggestions.push(command.name)
      }

      if (command.aliases) {
        for (const alias of command.aliases) {
          if (alias.startsWith(partial)) {
            suggestions.push(alias)
          }
        }
      }
    }

    return suggestions
  }

  /**
   * Load history from file
  */
  private async loadHistory(): Promise<void> {
    if (!this.options.historyFile) return

    try {
      const fs = await import('node:fs/promises')
      const data = await fs.readFile(this.options.historyFile, 'utf-8')
      this.history.commands = data.split('\n').filter(line => line.trim())
      this.historyIndex = this.history.commands.length
    }
    catch {
      // File doesn't exist or can't be read - that's ok
    }
  }

  /**
   * Save history to file
  */
  private async saveHistory(): Promise<void> {
    if (!this.options.historyFile) return

    try {
      const fs = await import('node:fs/promises')
      await fs.writeFile(this.options.historyFile, this.history.commands.join('\n'))
    }
    catch (error) {
      console.error(`Failed to save history: ${error}`)
    }
  }

  /**
   * Search history
  */
  searchHistory(query: string): string[] {
    return this.history.commands.filter(cmd => cmd.includes(query))
  }

  /**
   * Clear history
  */
  clearHistory(): void {
    this.history.commands = []
    this.historyIndex = 0
  }
}

/**
 * Context manager for REPL sessions
 * Maintains state across commands
*/
export class REPLContext {
  private variables: Map<string, any> = new Map()
  private workingDirectory: string = process.cwd()

  /**
   * Set variable
  */
  set(key: string, value: any): void {
    this.variables.set(key, value)
  }

  /**
   * Get variable
  */
  get(key: string): any {
    return this.variables.get(key)
  }

  /**
   * Check if variable exists
  */
  has(key: string): boolean {
    return this.variables.has(key)
  }

  /**
   * Delete variable
  */
  delete(key: string): void {
    this.variables.delete(key)
  }

  /**
   * Get all variables
  */
  getAll(): Record<string, any> {
    return Object.fromEntries(this.variables)
  }

  /**
   * Clear all variables
  */
  clear(): void {
    this.variables.clear()
  }

  /**
   * Set working directory
  */
  setWorkingDirectory(path: string): void {
    this.workingDirectory = path
  }

  /**
   * Get working directory
  */
  getWorkingDirectory(): string {
    return this.workingDirectory
  }
}

/**
 * Command builder for creating REPL commands
*/
export class REPLCommandBuilder {
  private command: Partial<REPLCommand> = {}

  name(name: string): this {
    this.command.name = name
    return this
  }

  description(description: string): this {
    this.command.description = description
    return this
  }

  aliases(...aliases: string[]): this {
    this.command.aliases = aliases
    return this
  }

  handler(handler: (args: string[]) => Promise<void> | void): this {
    this.command.handler = handler
    return this
  }

  autocomplete(fn: (partial: string) => string[]): this {
    this.command.autocomplete = fn
    return this
  }

  build(): REPLCommand {
    if (!this.command.name || !this.command.description || !this.command.handler) {
      throw new Error('Command must have name, description, and handler')
    }

    return this.command as REPLCommand
  }
}
