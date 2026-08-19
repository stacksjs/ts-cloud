import type { SchedulePreview } from './model'

const PRESETS: Record<string, string> = {
  every_minute: '* * * * *',
  every_five_minutes: '*/5 * * * *',
  hourly: '0 * * * *',
  daily: '0 0 * * *',
  weekly: '0 0 * * 0',
}
const MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
}
const DAYS: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
}

function validateTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date())
    return value
  } catch {
    throw new Error(`Unknown schedule timezone: ${value}`)
  }
}

function fieldNumber(value: string, names: Record<string, number>, minimum: number, maximum: number): number {
  const resolved = names[value.toUpperCase()] ?? Number(value)
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum)
    throw new Error(`Schedule field value ${value} is outside ${minimum}-${maximum}.`)
  return resolved
}

function parseField(
  source: string,
  minimum: number,
  maximum: number,
  names: Record<string, number> = {},
  transform?: (value: number) => number,
): Set<number> | undefined {
  if (source === '*' || source === '?') return undefined
  const values = new Set<number>()
  for (const item of source.split(',')) {
    const [range, stepText] = item.split('/')
    const step = stepText ? fieldNumber(stepText, {}, 1, maximum - minimum + 1) : 1
    let start: number
    let end: number
    if (range === '*') {
      start = minimum
      end = maximum
    } else if (range.includes('-')) {
      const parts = range.split('-')
      start = fieldNumber(parts[0], names, minimum, maximum)
      end = fieldNumber(parts[1], names, minimum, maximum)
    } else {
      start = fieldNumber(range, names, minimum, maximum)
      end = start
    }
    if (end < start) throw new Error('Schedule ranges must be ascending.')
    for (let value = start; value <= end; value += step)
      values.add(transform ? transform(value) : value === 7 && maximum === 7 ? 0 : value)
  }
  return values
}

function localParts(
  at: Date,
  zone: string,
): {
  minute: number
  hour: number
  day: number
  month: number
  weekday: number
  year: number
  key: string
} {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  )
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: DAYS[parts.weekday.toUpperCase()],
    year: Number(parts.year),
    key: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
  }
}

function cronFields(expression: string) {
  const inner = expression.startsWith('cron(') ? expression.slice(5, -1).trim() : expression.trim()
  const parts = inner.split(/\s+/)
  if (parts.length !== 5 && parts.length !== 6)
    throw new Error('Cron schedules require five standard fields or six EventBridge fields.')
  const [minute, hour, day, month, weekday, year] = parts
  const eventBridge = parts.length === 6
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    day: parseField(day, 1, 31),
    month: parseField(month, 1, 12, MONTHS),
    weekday: parseField(
      weekday,
      eventBridge ? 1 : 0,
      7,
      DAYS,
      eventBridge ? (value) => (value === 7 ? 6 : value - 1) : undefined,
    ),
    year: year ? parseField(year, 1970, 2199) : undefined,
    dayWildcard: day === '*' || day === '?',
    weekdayWildcard: weekday === '*' || weekday === '?',
  }
}

function matchesCron(parts: ReturnType<typeof localParts>, fields: ReturnType<typeof cronFields>): boolean {
  const basic =
    (!fields.minute || fields.minute.has(parts.minute)) &&
    (!fields.hour || fields.hour.has(parts.hour)) &&
    (!fields.month || fields.month.has(parts.month)) &&
    (!fields.year || fields.year.has(parts.year))
  if (!basic) return false
  const day = !fields.day || fields.day.has(parts.day)
  const weekday = !fields.weekday || fields.weekday.has(parts.weekday)
  return fields.dayWildcard ? weekday : fields.weekdayWildcard ? day : day || weekday
}

function rateMilliseconds(expression: string): number | undefined {
  const match = /^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/i.exec(expression)
  if (!match) return undefined
  const amount = Number(match[1])
  if (amount < 1) throw new Error('Rate amount must be positive.')
  return (
    amount *
    (match[2].toLowerCase().startsWith('minute')
      ? 60_000
      : match[2].toLowerCase().startsWith('hour')
        ? 3_600_000
        : 86_400_000)
  )
}

export function normalizeScheduleExpression(value: string): {
  original: string
  normalized: string
  kind: 'cron' | 'rate'
  description: string
} {
  const original = value.trim()
  const expression = PRESETS[original.toLowerCase()] ?? original
  if (!expression) throw new Error('Schedule expression is required.')
  const duration = rateMilliseconds(expression)
  if (duration) {
    const minutes = duration / 60_000
    return {
      original,
      normalized: `rate(${minutes} minutes)`,
      kind: 'rate',
      description:
        minutes % 1440 === 0
          ? `Every ${minutes / 1440} day(s)`
          : minutes % 60 === 0
            ? `Every ${minutes / 60} hour(s)`
            : `Every ${minutes} minute(s)`,
    }
  }
  cronFields(expression)
  return {
    original,
    normalized: expression.startsWith('cron(') ? expression : `cron(${expression})`,
    kind: 'cron',
    description: `Cron ${expression.replace(/^cron\(|\)$/g, '')}`,
  }
}

export function nextScheduleRuns(expression: string, zone: string, from: Date = new Date(), count = 5): string[] {
  const parsed = normalizeScheduleExpression(expression)
  const validatedZone = validateTimezone(zone)
  const amount = Math.min(20, Math.max(1, count))
  const duration = rateMilliseconds(parsed.normalized)
  if (duration)
    return Array.from({ length: amount }, (_, index) => new Date(from.getTime() + duration * (index + 1)).toISOString())
  const fields = cronFields(parsed.normalized)
  const runs: string[] = []
  const seen = new Set<string>()
  let cursor = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000)
  let iterations = 0
  while (runs.length < amount && iterations < 1_100_000) {
    const parts = localParts(cursor, validatedZone)
    if (matchesCron(parts, fields) && !seen.has(parts.key)) {
      runs.push(cursor.toISOString())
      seen.add(parts.key)
    }
    cursor = new Date(cursor.getTime() + 60_000)
    iterations++
  }
  if (runs.length < amount) throw new Error('Schedule produced no runs within the bounded preview horizon.')
  return runs
}

export function previewSchedule(expression: string, zone = 'UTC', from: Date = new Date(), count = 5): SchedulePreview {
  const parsed = normalizeScheduleExpression(expression)
  const nextRuns = nextScheduleRuns(parsed.normalized, zone, from, count)
  const notes =
    parsed.kind === 'cron'
      ? [
          'Server cron and EventBridge use the same wall-clock preview; provider-specific extensions are retained only when supported.',
        ]
      : ['Rate schedules use elapsed-time intervals and are not shifted by DST.']
  return {
    ...parsed,
    timezone: validateTimezone(zone),
    nextRuns,
    capabilities: { server: parsed.kind === 'cron', eventbridge: true, notes },
  }
}
