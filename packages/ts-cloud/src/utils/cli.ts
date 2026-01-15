/**
 * CLI Utility Functions
 * Helpers for colored output, spinners, prompts, and formatting
 */

// ANSI color codes
export const colors = {
  reset: '\x1B[0m',
  bright: '\x1B[1m',
  dim: '\x1B[2m',
  red: '\x1B[31m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  blue: '\x1B[34m',
  magenta: '\x1B[35m',
  cyan: '\x1B[36m',
  white: '\x1B[37m',
  gray: '\x1B[90m',
}

/**
 * Colorize text
 */
export function colorize(text: string, color: keyof typeof colors): string {
  return `${colors[color]}${text}${colors.reset}`
}

/**
 * Success message
 */
export function success(message: string): void {
  console.log(`${colors.green}✓${colors.reset} ${message}`)
}

/**
 * Error message
 */
export function error(message: string): void {
  console.error(`${colors.red}✗${colors.reset} ${message}`)
}

/**
 * Warning message
 */
export function warn(message: string): void {
  console.warn(`${colors.yellow}⚠${colors.reset} ${message}`)
}

/**
 * Warning message (alias)
 */
export const warning: typeof warn = warn

/**
 * Info message
 */
export function info(message: string): void {
  console.log(`${colors.blue}ℹ${colors.reset} ${message}`)
}

/**
 * Step message
 */
export function step(message: string): void {
  console.log(`${colors.cyan}→${colors.reset} ${message}`)
}

/**
 * Header message
 */
export function header(message: string): void {
  console.log(`\n${colors.bright}${colors.cyan}${message}${colors.reset}\n`)
}

/**
 * Simple spinner
 */
export class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  private interval: Timer | null = null
  private currentFrame = 0
  private message: string

  constructor(message: string) {
    this.message = message
  }

  get text(): string {
    return this.message
  }

  set text(value: string) {
    this.message = value
  }

  start(): void {
    this.interval = setInterval(() => {
      process.stdout.write(`\r${colors.cyan}${this.frames[this.currentFrame]}${colors.reset} ${this.message}`)
      this.currentFrame = (this.currentFrame + 1) % this.frames.length
    }, 80)
  }

  succeed(message?: string): void {
    this.stop()
    success(message || this.message)
  }

  fail(message?: string): void {
    this.stop()
    error(message || this.message)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      process.stdout.write('\r')
    }
  }
}

/**
 * Progress bar
 */
export class ProgressBar {
  private total: number
  private current = 0
  private width = 40

  constructor(total: number) {
    this.total = total
  }

  update(current: number): void {
    this.current = current
    this.render()
  }

  increment(): void {
    this.current++
    this.render()
  }

  private render(): void {
    const percentage = Math.floor((this.current / this.total) * 100)
    const filled = Math.floor((this.current / this.total) * this.width)
    const empty = this.width - filled

    const bar = `${'█'.repeat(filled)}${'░'.repeat(empty)}`
    process.stdout.write(`\r${colors.cyan}${bar}${colors.reset} ${percentage}% (${this.current}/${this.total})`)

    if (this.current >= this.total) {
      process.stdout.write('\n')
    }
  }
}

/**
 * Prompt for user input
 */
export async function prompt(message: string, defaultValue?: string): Promise<string> {
  const readline = await import('node:readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    const promptText = defaultValue
      ? `${colors.cyan}?${colors.reset} ${message} ${colors.gray}(${defaultValue})${colors.reset}: `
      : `${colors.cyan}?${colors.reset} ${message}: `

    rl.question(promptText, (answer) => {
      rl.close()
      resolve(answer || defaultValue || '')
    })
  })
}

/**
 * Prompt for confirmation (yes/no)
 */
export async function confirm(message: string, defaultValue = false): Promise<boolean> {
  const answer = await prompt(`${message} (y/n)`, defaultValue ? 'y' : 'n')
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes'
}

/**
 * Select from a list of options
 */
export async function select(message: string, options: string[]): Promise<string> {
  console.log(`${colors.cyan}?${colors.reset} ${message}`)
  options.forEach((option, index) => {
    console.log(`  ${colors.gray}${index + 1}.${colors.reset} ${option}`)
  })

  const answer = await prompt('Select', '1')
  const index = Number.parseInt(answer) - 1

  if (index >= 0 && index < options.length) {
    return options[index]
  }

  return options[0]
}

/**
 * Format a table
 */
export function table(headers: string[], rows: string[][]): void {
  // Calculate column widths
  const widths = headers.map((header, i) => {
    const maxRowWidth = Math.max(...rows.map(row => (row[i] || '').length))
    return Math.max(header.length, maxRowWidth)
  })

  // Print header
  const headerRow = headers.map((header, i) => header.padEnd(widths[i])).join('  ')
  console.log(colorize(headerRow, 'bright'))
  console.log(colorize('─'.repeat(headerRow.length), 'gray'))

  // Print rows
  rows.forEach((row) => {
    const formattedRow = row.map((cell, i) => (cell || '').padEnd(widths[i])).join('  ')
    console.log(formattedRow)
  })
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0)
    return '0 B'

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`
}

/**
 * Format duration to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1000)
    return `${ms}ms`

  const seconds = Math.floor(ms / 1000)
  if (seconds < 60)
    return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60

  if (minutes < 60)
    return `${minutes}m ${remainingSeconds}s`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60

  return `${hours}h ${remainingMinutes}m`
}

/**
 * Box a message
 */
export function box(message: string, color: keyof typeof colors = 'cyan'): void {
  const lines = message.split('\n')
  const maxLength = Math.max(...lines.map(line => line.length))
  const border = '─'.repeat(maxLength + 2)

  console.log(colorize(`┌${border}┐`, color))
  lines.forEach((line) => {
    console.log(colorize(`│ ${line.padEnd(maxLength)} │`, color))
  })
  console.log(colorize(`└${border}┘`, color))
}

/**
 * Check if AWS CLI is installed (deprecated - no longer required)
 * @deprecated AWS CLI is no longer required. Use checkAwsCredentials() instead.
 */
export async function checkAwsCli(): Promise<boolean> {
  // AWS CLI is no longer required - direct API calls are used
  return true
}

/**
 * Check if AWS credentials are configured
 * Uses direct API call to STS GetCallerIdentity
 */
export async function checkAwsCredentials(): Promise<boolean> {
  try {
    const { AWSClient } = await import('../aws/client')
    const client = new AWSClient()

    await client.request({
      service: 'sts',
      region: 'us-east-1',
      method: 'POST',
      path: '/',
      body: new URLSearchParams({
        Action: 'GetCallerIdentity',
        Version: '2011-06-15',
      }).toString(),
    })

    return true
  }
  catch {
    return false
  }
}

/**
 * Get AWS account ID using direct STS API call
 */
export async function getAwsAccountId(): Promise<string | null> {
  try {
    const { AWSClient } = await import('../aws/client')
    const client = new AWSClient()

    const result = await client.request({
      service: 'sts',
      region: 'us-east-1',
      method: 'POST',
      path: '/',
      body: new URLSearchParams({
        Action: 'GetCallerIdentity',
        Version: '2011-06-15',
      }).toString(),
    })

    return result.Account || result.GetCallerIdentityResult?.Account || null
  }
  catch {
    return null
  }
}

/**
 * Get AWS regions using direct EC2 API call
 */
export async function getAwsRegions(): Promise<string[]> {
  try {
    const { AWSClient } = await import('../aws/client')
    const client = new AWSClient()

    const result = await client.request({
      service: 'ec2',
      region: 'us-east-1',
      method: 'POST',
      path: '/',
      body: new URLSearchParams({
        Action: 'DescribeRegions',
        Version: '2016-11-15',
      }).toString(),
    })

    // Parse regions from response
    const regions: string[] = []
    if (result.regionInfo) {
      const regionData = Array.isArray(result.regionInfo)
        ? result.regionInfo
        : [result.regionInfo]

      regions.push(...regionData.map((r: any) => r.regionName))
    }

    return regions.length > 0 ? regions : getCommonAwsRegions()
  }
  catch {
    // Return common regions as fallback
    return getCommonAwsRegions()
  }
}

/**
 * Get common AWS regions as fallback
 */
function getCommonAwsRegions(): string[] {
  return [
    'us-east-1',
    'us-east-2',
    'us-west-1',
    'us-west-2',
    'eu-west-1',
    'eu-central-1',
    'ap-southeast-1',
    'ap-northeast-1',
  ]
}
