import { describe, expect, it } from 'bun:test'
import {
  formatTable,
  formatTree,
  formatProgressBar,
  formatBytes,
  formatDuration,
  formatList,
  formatKeyValue,
} from './table'

describe('Table Formatting', () => {
  describe('formatTable', () => {
    it('should format basic table', () => {
      const result = formatTable({
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'age', label: 'Age' },
        ],
        data: [
          { name: 'Alice', age: 25 },
          { name: 'Bob', age: 30 },
        ],
      })

      expect(result).toContain('Name')
      expect(result).toContain('Age')
      expect(result).toContain('Alice')
      expect(result).toContain('Bob')
      expect(result).toContain('25')
      expect(result).toContain('30')
    })

    it('should handle empty data', () => {
      const result = formatTable({
        columns: [
          { key: 'name', label: 'Name' },
        ],
        data: [],
      })

      expect(result).toBe('No data to display')
    })

    it('should apply formatters', () => {
      const result = formatTable({
        columns: [
          { key: 'name', label: 'Name' },
          {
            key: 'amount',
            label: 'Amount',
            formatter: (val) => `$${val}`,
          },
        ],
        data: [
          { name: 'Item', amount: 100 },
        ],
      })

      expect(result).toContain('$100')
    })

    it('should align columns', () => {
      const result = formatTable({
        columns: [
          { key: 'name', label: 'Name', align: 'left' },
          { key: 'age', label: 'Age', align: 'right' },
        ],
        data: [
          { name: 'Alice', age: 25 },
        ],
      })

      expect(result).toContain('Alice')
      expect(result).toContain('25')
    })

    it('should handle missing values', () => {
      const result = formatTable({
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'age', label: 'Age' },
        ],
        data: [
          { name: 'Alice' }, // Missing age
        ],
      })

      expect(result).toContain('Alice')
    })
  })

  describe('formatTree', () => {
    it('should format tree structure', () => {
      const result = formatTree([
        {
          label: 'Root',
          children: [
            { label: 'Child 1' },
            { label: 'Child 2' },
          ],
        },
      ])

      expect(result).toContain('Root')
      expect(result).toContain('Child 1')
      expect(result).toContain('Child 2')
      expect(result).toContain('├─')
      expect(result).toContain('└─')
    })

    it('should show metadata when enabled', () => {
      const result = formatTree(
        [
          {
            label: 'Node',
            metadata: { status: 'active', count: 5 },
          },
        ],
        { showMetadata: true },
      )

      expect(result).toContain('Node')
      expect(result).toContain('status')
      expect(result).toContain('active')
      expect(result).toContain('count')
      expect(result).toContain('5')
    })

    it('should handle nested children', () => {
      const result = formatTree([
        {
          label: 'Level 1',
          children: [
            {
              label: 'Level 2',
              children: [
                { label: 'Level 3' },
              ],
            },
          ],
        },
      ])

      expect(result).toContain('Level 1')
      expect(result).toContain('Level 2')
      expect(result).toContain('Level 3')
    })
  })

  describe('formatProgressBar', () => {
    it('should format progress bar at 0%', () => {
      const result = formatProgressBar({
        total: 100,
        current: 0,
      })

      expect(result).toContain('0%')
      expect(result).toContain('0/100')
    })

    it('should format progress bar at 50%', () => {
      const result = formatProgressBar({
        total: 100,
        current: 50,
      })

      expect(result).toContain('50%')
      expect(result).toContain('50/100')
    })

    it('should format progress bar at 100%', () => {
      const result = formatProgressBar({
        total: 100,
        current: 100,
      })

      expect(result).toContain('100%')
      expect(result).toContain('100/100')
    })

    it('should use custom format', () => {
      const result = formatProgressBar({
        total: 100,
        current: 50,
        format: ':percent complete',
      })

      expect(result).toContain('50% complete')
    })

    it('should handle partial progress', () => {
      const result = formatProgressBar({
        total: 10,
        current: 3,
      })

      expect(result).toContain('30%')
    })
  })

  describe('formatBytes', () => {
    it('should format bytes', () => {
      expect(formatBytes(0)).toBe('0 Bytes')
      expect(formatBytes(100)).toBe('100 Bytes')
      expect(formatBytes(1024)).toBe('1 KB')
      expect(formatBytes(1024 * 1024)).toBe('1 MB')
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB')
    })

    it('should handle decimals', () => {
      const result = formatBytes(1536, 2) // 1.5 KB
      expect(result).toContain('1.5')
      expect(result).toContain('KB')
    })

    it('should format large values', () => {
      const result = formatBytes(1024 * 1024 * 1024 * 1024) // 1 TB
      expect(result).toContain('1')
      expect(result).toContain('TB')
    })
  })

  describe('formatDuration', () => {
    it('should format milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms')
    })

    it('should format seconds', () => {
      expect(formatDuration(5000)).toBe('5s')
      expect(formatDuration(45000)).toBe('45s')
    })

    it('should format minutes', () => {
      expect(formatDuration(60000)).toBe('1m')
      expect(formatDuration(90000)).toBe('1m 30s')
      expect(formatDuration(120000)).toBe('2m')
    })

    it('should format hours', () => {
      expect(formatDuration(3600000)).toBe('1h')
      expect(formatDuration(5400000)).toBe('1h 30m')
      expect(formatDuration(7200000)).toBe('2h')
    })

    it('should format days', () => {
      expect(formatDuration(86400000)).toBe('1d')
      expect(formatDuration(90000000)).toBe('1d 1h')
    })
  })

  describe('formatList', () => {
    it('should format simple list', () => {
      const result = formatList(['Item 1', 'Item 2', 'Item 3'])

      expect(result).toContain('• Item 1')
      expect(result).toContain('• Item 2')
      expect(result).toContain('• Item 3')
    })

    it('should use custom bullet', () => {
      const result = formatList(['Item 1', 'Item 2'], '-')

      expect(result).toContain('- Item 1')
      expect(result).toContain('- Item 2')
    })

    it('should handle empty list', () => {
      const result = formatList([])
      expect(result).toBe('')
    })
  })

  describe('formatKeyValue', () => {
    it('should format key-value pairs', () => {
      const result = formatKeyValue({
        name: 'Alice',
        age: 25,
        city: 'NYC',
      })

      expect(result).toContain('name')
      expect(result).toContain('Alice')
      expect(result).toContain('age')
      expect(result).toContain('25')
      expect(result).toContain('city')
      expect(result).toContain('NYC')
    })

    it('should align keys', () => {
      const result = formatKeyValue({
        a: '1',
        abc: '2',
        abcdef: '3',
      })

      // Keys should be padded to same length
      expect(result).toContain(':')
    })

    it('should use custom separator', () => {
      const result = formatKeyValue(
        { name: 'Alice' },
        { separator: ' = ' },
      )

      expect(result).toContain('name = Alice')
    })

    it('should indent output', () => {
      const result = formatKeyValue(
        { name: 'Alice' },
        { indent: '  ' },
      )

      expect(result).toMatch(/^\s+name/)
    })
  })
})
