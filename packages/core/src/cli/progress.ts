/**
 * Progress tracking with ETA and status updates
 * Provides interactive progress bars and status indicators
*/

export interface ProgressOptions {
  total: number
  current?: number
  width?: number
  format?: string
  message?: string
  showETA?: boolean
  showPercentage?: boolean
  showCounter?: boolean
}

/**
 * Progress bar with ETA calculation
*/
export class ProgressBar {
  private total: number
  private current: number = 0
  private width: number
  private format: string
  private message: string
  private showETA: boolean
  private showPercentage: boolean
  private showCounter: boolean
  private startTime: number = Date.now()
  private lastUpdate: number = 0

  constructor(options: ProgressOptions) {
    this.total = options.total
    this.current = options.current || 0
    this.width = options.width || 40
    this.format = options.format || ':message :bar :percent :eta'
    this.message = options.message || 'Progress'
    this.showETA = options.showETA !== false
    this.showPercentage = options.showPercentage !== false
    this.showCounter = options.showCounter !== false
  }

  /**
   * Update progress
  */
  tick(amount: number = 1): void {
    this.current = Math.min(this.total, this.current + amount)
    this.lastUpdate = Date.now()
  }

  /**
   * Set progress to specific value
  */
  update(current: number): void {
    this.current = Math.min(this.total, Math.max(0, current))
    this.lastUpdate = Date.now()
  }

  /**
   * Set message
  */
  setMessage(message: string): void {
    this.message = message
  }

  /**
   * Get current progress percentage
  */
  getPercentage(): number {
    return Math.min(100, (this.current / this.total) * 100)
  }

  /**
   * Calculate ETA in milliseconds
  */
  getETA(): number {
    if (this.current === 0) return 0

    const elapsed = Date.now() - this.startTime
    const rate = this.current / elapsed
    const remaining = this.total - this.current

    return Math.round(remaining / rate)
  }

  /**
   * Format ETA as human-readable string
  */
  getETAFormatted(): string {
    if (this.current === 0) return 'calculating...'
    if (this.current === this.total) return 'complete'

    const eta = this.getETA()

    if (eta < 1000) return '< 1s'
    if (eta < 60000) return `${Math.round(eta / 1000)}s`

    const minutes = Math.floor(eta / 60000)
    if (minutes < 60) return `${minutes}m`

    const hours = Math.floor(minutes / 60)
    const remainingMinutes = minutes % 60

    if (hours < 24) {
      return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
    }

    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24

    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
  }

  /**
   * Render progress bar
  */
  render(): string {
    const percentage = this.getPercentage()
    const completed = Math.floor((this.width * this.current) / this.total)
    const remaining = this.width - completed

    const bar = '█'.repeat(completed) + '░'.repeat(remaining)
    const percentStr = `${percentage.toFixed(1)}%`
    const counterStr = `${this.current}/${this.total}`
    const etaStr = this.showETA ? `ETA: ${this.getETAFormatted()}` : ''

    let output = this.format
      .replace(':message', this.message)
      .replace(':bar', bar)
      .replace(':percent', this.showPercentage ? percentStr : '')
      .replace(':counter', this.showCounter ? counterStr : '')
      .replace(':eta', etaStr)
      .replace(':current', String(this.current))
      .replace(':total', String(this.total))

    // Clean up extra spaces
    output = output.replace(/\s+/g, ' ').trim()

    return output
  }

  /**
   * Check if complete
  */
  isComplete(): boolean {
    return this.current >= this.total
  }
}

/**
 * Multi-step progress tracker
*/
export interface Step {
  name: string
  status: 'pending' | 'active' | 'completed' | 'failed' | 'skipped'
  message?: string
  error?: string
}

export class MultiStepProgress {
  private steps: Step[]
  private currentStepIndex: number = 0

  constructor(stepNames: string[]) {
    this.steps = stepNames.map(name => ({
      name,
      status: 'pending',
    }))
  }

  /**
   * Start a step
  */
  startStep(index: number, message?: string): void {
    if (index >= 0 && index < this.steps.length) {
      this.steps[index].status = 'active'
      this.steps[index].message = message
      this.currentStepIndex = index
    }
  }

  /**
   * Complete current step
  */
  completeStep(message?: string): void {
    if (this.currentStepIndex >= 0 && this.currentStepIndex < this.steps.length) {
      this.steps[this.currentStepIndex].status = 'completed'
      this.steps[this.currentStepIndex].message = message
      this.currentStepIndex++
    }
  }

  /**
   * Fail current step
  */
  failStep(error: string): void {
    if (this.currentStepIndex >= 0 && this.currentStepIndex < this.steps.length) {
      this.steps[this.currentStepIndex].status = 'failed'
      this.steps[this.currentStepIndex].error = error
    }
  }

  /**
   * Skip current step
  */
  skipStep(message?: string): void {
    if (this.currentStepIndex >= 0 && this.currentStepIndex < this.steps.length) {
      this.steps[this.currentStepIndex].status = 'skipped'
      this.steps[this.currentStepIndex].message = message
      this.currentStepIndex++
    }
  }

  /**
   * Get step by index
  */
  getStep(index: number): Step | undefined {
    return this.steps[index]
  }

  /**
   * Get all steps
  */
  getSteps(): Step[] {
    return this.steps
  }

  /**
   * Render progress
  */
  render(): string {
    const lines: string[] = []

    for (const step of this.steps) {
      const icon = this.getStatusIcon(step.status)
      let line = `${icon} ${step.name}`

      if (step.message) {
        line += ` - ${step.message}`
      }

      if (step.error) {
        line += `\n   Error: ${step.error}`
      }

      lines.push(line)
    }

    return lines.join('\n')
  }

  /**
   * Get status icon
  */
  private getStatusIcon(status: Step['status']): string {
    switch (status) {
      case 'pending':
        return '○'
      case 'active':
        return '◐'
      case 'completed':
        return '✓'
      case 'failed':
        return '✗'
      case 'skipped':
        return '⊘'
      default:
        return '○'
    }
  }

  /**
   * Check if all steps complete
  */
  isComplete(): boolean {
    return this.steps.every(step => step.status === 'completed' || step.status === 'skipped')
  }

  /**
   * Check if any step failed
  */
  hasFailed(): boolean {
    return this.steps.some(step => step.status === 'failed')
  }
}

/**
 * Spinner for indeterminate progress
*/
export class Spinner {
  private frames: string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  private currentFrame: number = 0
  private message: string
  private interval: Timer | null = null

  constructor(message: string = 'Loading...') {
    this.message = message
  }

  /**
   * Start spinner
  */
  start(): void {
    if (this.interval) return

    this.interval = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length
      // In a real CLI, we'd use process.stdout.write here
    }, 80)
  }

  /**
   * Stop spinner
  */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  /**
   * Set message
  */
  setMessage(message: string): void {
    this.message = message
  }

  /**
   * Render current frame
  */
  render(): string {
    return `${this.frames[this.currentFrame]} ${this.message}`
  }

  /**
   * Succeed with checkmark
  */
  succeed(message?: string): string {
    this.stop()
    return `✓ ${message || this.message}`
  }

  /**
   * Fail with X
  */
  fail(message?: string): string {
    this.stop()
    return `✗ ${message || this.message}`
  }

  /**
   * Warn with exclamation
  */
  warn(message?: string): string {
    this.stop()
    return `⚠ ${message || this.message}`
  }

  /**
   * Info with i
  */
  info(message?: string): string {
    this.stop()
    return `ℹ ${message || this.message}`
  }
}

/**
 * Task list with status tracking
*/
export interface Task {
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  output?: string
}

export class TaskList {
  private tasks: Task[] = []

  /**
   * Add task
  */
  add(title: string): number {
    this.tasks.push({
      title,
      status: 'pending',
    })
    return this.tasks.length - 1
  }

  /**
   * Start task
  */
  start(index: number): void {
    if (index >= 0 && index < this.tasks.length) {
      this.tasks[index].status = 'running'
    }
  }

  /**
   * Complete task
  */
  complete(index: number, output?: string): void {
    if (index >= 0 && index < this.tasks.length) {
      this.tasks[index].status = 'completed'
      this.tasks[index].output = output
    }
  }

  /**
   * Fail task
  */
  fail(index: number, output?: string): void {
    if (index >= 0 && index < this.tasks.length) {
      this.tasks[index].status = 'failed'
      this.tasks[index].output = output
    }
  }

  /**
   * Render task list
  */
  render(): string {
    const lines: string[] = []

    for (const task of this.tasks) {
      const icon = this.getStatusIcon(task.status)
      let line = `${icon} ${task.title}`

      if (task.output) {
        line += `\n   ${task.output}`
      }

      lines.push(line)
    }

    return lines.join('\n')
  }

  /**
   * Get status icon
  */
  private getStatusIcon(status: Task['status']): string {
    switch (status) {
      case 'pending':
        return '○'
      case 'running':
        return '◐'
      case 'completed':
        return '✓'
      case 'failed':
        return '✗'
      default:
        return '○'
    }
  }
}
