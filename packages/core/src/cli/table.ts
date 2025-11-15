/**
 * Table formatting utilities for CLI output
 * Better table rendering with borders, alignment, colors
 */

export interface TableColumn {
  key: string
  label: string
  width?: number
  align?: 'left' | 'right' | 'center'
  formatter?: (value: any) => string
}

export interface TableOptions {
  columns: TableColumn[]
  data: Record<string, any>[]
  border?: boolean
  header?: boolean
  compact?: boolean
  maxWidth?: number
}

/**
 * Format data as a table
 */
export function formatTable(options: TableOptions): string {
  const { columns, data, border = true, header = true, compact = false, maxWidth } = options

  if (data.length === 0) {
    return 'No data to display'
  }

  // Calculate column widths
  const colWidths = columns.map((col) => {
    const labelWidth = col.label.length
    const dataWidth = Math.max(
      ...data.map((row) => {
        const value = col.formatter ? col.formatter(row[col.key]) : String(row[col.key] || '')
        return value.length
      }),
    )

    let width = col.width || Math.max(labelWidth, dataWidth)

    // Apply max width if specified
    if (maxWidth && width > maxWidth) {
      width = maxWidth
    }

    return width
  })

  const lines: string[] = []

  // Top border
  if (border) {
    lines.push(createBorder(colWidths, 'top', compact))
  }

  // Header
  if (header) {
    lines.push(createRow(columns.map(col => col.label), colWidths, columns.map(col => col.align || 'left'), border))

    // Header separator
    if (border) {
      lines.push(createBorder(colWidths, 'middle', compact))
    }
  }

  // Data rows
  for (const row of data) {
    const values = columns.map((col) => {
      const value = col.formatter ? col.formatter(row[col.key]) : String(row[col.key] || '')
      return truncate(value, colWidths[columns.indexOf(col)])
    })

    lines.push(createRow(values, colWidths, columns.map(col => col.align || 'left'), border))
  }

  // Bottom border
  if (border) {
    lines.push(createBorder(colWidths, 'bottom', compact))
  }

  return lines.join('\n')
}

/**
 * Create a table row
 */
function createRow(
  values: string[],
  widths: number[],
  alignments: Array<'left' | 'right' | 'center'>,
  border: boolean,
): string {
  const cells = values.map((value, i) => {
    const width = widths[i]
    const align = alignments[i]

    return alignText(value, width, align)
  })

  if (border) {
    return `│ ${cells.join(' │ ')} │`
  }

  return cells.join('  ')
}

/**
 * Create a table border
 */
function createBorder(widths: number[], position: 'top' | 'middle' | 'bottom', compact: boolean): string {
  const left = position === 'top' ? '┌' : position === 'middle' ? '├' : '└'
  const right = position === 'top' ? '┐' : position === 'middle' ? '┤' : '┘'
  const cross = position === 'top' ? '┬' : position === 'middle' ? '┼' : '┴'
  const horizontal = '─'

  if (compact) {
    return left + widths.map(w => horizontal.repeat(w + 2)).join(cross) + right
  }

  return left + widths.map(w => horizontal.repeat(w + 2)).join(cross) + right
}

/**
 * Align text within a fixed width
 */
function alignText(text: string, width: number, align: 'left' | 'right' | 'center'): string {
  const textWidth = stripAnsi(text).length

  if (textWidth >= width) {
    return text
  }

  const padding = width - textWidth

  switch (align) {
    case 'right':
      return ' '.repeat(padding) + text
    case 'center': {
      const leftPad = Math.floor(padding / 2)
      const rightPad = padding - leftPad
      return ' '.repeat(leftPad) + text + ' '.repeat(rightPad)
    }
    default:
      return text + ' '.repeat(padding)
  }
}

/**
 * Truncate text to fit width
 */
function truncate(text: string, width: number): string {
  const textWidth = stripAnsi(text).length

  if (textWidth <= width) {
    return text
  }

  // Truncate and add ellipsis
  return text.substring(0, width - 1) + '…'
}

/**
 * Strip ANSI color codes from string
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*m/g, '')
}

/**
 * Format data as a tree structure
 */
export interface TreeNode {
  label: string
  children?: TreeNode[]
  metadata?: Record<string, any>
}

export interface TreeOptions {
  indent?: string
  showMetadata?: boolean
}

/**
 * Format data as a tree
 */
export function formatTree(nodes: TreeNode[], options: TreeOptions = {}): string {
  const { indent = '  ', showMetadata = false } = options

  const lines: string[] = []

  function renderNode(node: TreeNode, prefix: string, isLast: boolean): void {
    const connector = isLast ? '└─ ' : '├─ '
    const line = prefix + connector + node.label

    lines.push(line)

    // Render metadata if enabled
    if (showMetadata && node.metadata) {
      const metadataPrefix = prefix + (isLast ? '   ' : '│  ')
      for (const [key, value] of Object.entries(node.metadata)) {
        lines.push(`${metadataPrefix}${key}: ${value}`)
      }
    }

    // Render children
    if (node.children && node.children.length > 0) {
      const childPrefix = prefix + (isLast ? '   ' : '│  ')
      node.children.forEach((child, index) => {
        renderNode(child, childPrefix, index === node.children!.length - 1)
      })
    }
  }

  nodes.forEach((node, index) => {
    renderNode(node, '', index === nodes.length - 1)
  })

  return lines.join('\n')
}

/**
 * Create a simple progress bar
 */
export interface ProgressBarOptions {
  total: number
  current: number
  width?: number
  format?: string
  complete?: string
  incomplete?: string
}

/**
 * Format a progress bar
 */
export function formatProgressBar(options: ProgressBarOptions): string {
  const {
    total,
    current,
    width = 40,
    format = ':bar :percent :current/:total',
    complete = '█',
    incomplete = '░',
  } = options

  const percentage = Math.min(100, Math.max(0, (current / total) * 100))
  const completed = Math.floor((width * current) / total)
  const remaining = width - completed

  const bar = complete.repeat(completed) + incomplete.repeat(remaining)

  return format
    .replace(':bar', bar)
    .replace(':percent', `${percentage.toFixed(0)}%`)
    .replace(':current', String(current))
    .replace(':total', String(total))
}

/**
 * Format bytes as human-readable size
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes'

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']

  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

/**
 * Format duration as human-readable time
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`

  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60

  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }

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
 * Format list with bullets
 */
export function formatList(items: string[], bullet = '•'): string {
  return items.map(item => `${bullet} ${item}`).join('\n')
}

/**
 * Format key-value pairs
 */
export function formatKeyValue(
  data: Record<string, any>,
  options: { indent?: string; separator?: string } = {},
): string {
  const { indent = '', separator = ': ' } = options

  const maxKeyLength = Math.max(...Object.keys(data).map(k => k.length))

  return Object.entries(data)
    .map(([key, value]) => {
      const paddedKey = key.padEnd(maxKeyLength)
      return `${indent}${paddedKey}${separator}${value}`
    })
    .join('\n')
}
