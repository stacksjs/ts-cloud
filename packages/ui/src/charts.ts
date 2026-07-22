import { curveMonotoneX, line, scaleBand, scaleLinear } from '@ts-charts/charts'

export interface ResourcePoint {
  label: string
  value: number
  detail?: string
  tone?: 'ok' | 'warn' | 'bad' | 'muted'
}

export interface DeploymentPoint {
  timestamp?: string
  status?: string
  site?: string
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function toneClass(value: ResourcePoint): string {
  if (value.tone) return value.tone
  if (value.value >= 90) return 'bad'
  if (value.value >= 70) return 'warn'
  return 'ok'
}

export function renderResourceBars(points: ResourcePoint[], options: { disabled?: boolean } = {}): string {
  const width = 640
  const height = 210
  const margin = { top: 18, right: 20, bottom: 44, left: 38 }
  const innerW = width - margin.left - margin.right
  const innerH = height - margin.top - margin.bottom
  const labels = points.map((point) => point.label)
  const x = scaleBand()
    .domain(labels)
    .range([margin.left, margin.left + innerW])
    .paddingInner(0.28)
    .paddingOuter(0.12)
  const y = scaleLinear()
    .domain([0, 100])
    .range([margin.top + innerH, margin.top])
  const bandwidth = Math.max(12, x.bandwidth?.() ?? 28)

  if (options.disabled) {
    return `<svg class="chart disabled resource-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Server metrics unavailable">
      <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="14" class="chart-shell"></rect>
      <text x="${width / 2}" y="${height / 2 - 8}" text-anchor="middle" class="chart-empty-title">Metrics unavailable</text>
      <text x="${width / 2}" y="${height / 2 + 16}" text-anchor="middle" class="chart-empty-sub">The dashboard could not reach the server probe.</text>
    </svg>`
  }

  const grid = [0, 25, 50, 75, 100]
    .map((tick) => {
      const gy = y(tick)
      return `<line x1="${margin.left}" x2="${margin.left + innerW}" y1="${gy}" y2="${gy}" class="chart-grid"></line><text x="${margin.left - 10}" y="${gy + 4}" text-anchor="end" class="chart-axis">${tick}</text>`
    })
    .join('')

  const bars = points
    .map((point) => {
      const value = clampPercent(point.value)
      const bx = x(point.label) ?? margin.left
      const by = y(value)
      const bh = margin.top + innerH - by
      return `<g class="bar-mark ${toneClass(point)}">
      <rect x="${bx}" y="${by}" width="${bandwidth}" height="${bh}" rx="7"></rect>
      <text x="${bx + bandwidth / 2}" y="${by - 8}" text-anchor="middle" class="chart-value">${value}%</text>
      <text x="${bx + bandwidth / 2}" y="${height - 20}" text-anchor="middle" class="chart-label">${esc(point.label)}</text>
      ${point.detail ? `<title>${esc(point.detail)}</title>` : ''}
    </g>`
    })
    .join('')

  return `<svg class="chart resource-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Server resource chart">
    <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="14" class="chart-shell"></rect>
    ${grid}
    ${bars}
  </svg>`
}

export function renderDeploymentSparkline(records: DeploymentPoint[]): string {
  const width = 640
  const height = 164
  const margin = { top: 22, right: 22, bottom: 28, left: 22 }
  const innerW = width - margin.left - margin.right
  const innerH = height - margin.top - margin.bottom
  const sorted = [...records]
    .filter((record) => record.timestamp)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))

  if (sorted.length === 0) {
    return `<svg class="chart deployment-chart disabled" viewBox="0 0 ${width} ${height}" role="img" aria-label="No deployment history">
      <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="14" class="chart-shell"></rect>
      <text x="${width / 2}" y="${height / 2 - 6}" text-anchor="middle" class="chart-empty-title">No deploy records yet</text>
      <text x="${width / 2}" y="${height / 2 + 18}" text-anchor="middle" class="chart-empty-sub">Deploy again and this timeline will fill in automatically.</text>
    </svg>`
  }

  const buckets = sorted.map((record, index) => ({
    x: sorted.length === 1 ? margin.left + innerW / 2 : margin.left + (index / (sorted.length - 1)) * innerW,
    y: margin.top + (record.status === 'failed' ? innerH * 0.78 : innerH * 0.26),
    record,
  }))

  const path =
    line<any>()
      .x((d: any) => d.x)
      .y((d: any) => d.y)
      .curve(curveMonotoneX)(buckets) ?? ''

  const dots = buckets
    .map(
      ({ x, y, record }) =>
        `<circle cx="${x}" cy="${y}" r="5" class="${record.status === 'failed' ? 'bad' : 'ok'}"><title>${esc(record.site)} · ${esc(record.status)}</title></circle>`,
    )
    .join('')

  return `<svg class="chart deployment-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Deployment history chart">
    <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="14" class="chart-shell"></rect>
    <line x1="${margin.left}" x2="${margin.left + innerW}" y1="${margin.top + innerH * 0.26}" y2="${margin.top + innerH * 0.26}" class="chart-grid"></line>
    <line x1="${margin.left}" x2="${margin.left + innerW}" y1="${margin.top + innerH * 0.78}" y2="${margin.top + innerH * 0.78}" class="chart-grid"></line>
    <path d="${esc(path)}" class="spark-path"></path>
    ${dots}
    <text x="${margin.left}" y="${height - 12}" class="chart-axis">${sorted.length} deploy${sorted.length === 1 ? '' : 's'}</text>
    <text x="${width - margin.right}" y="${height - 12}" text-anchor="end" class="chart-axis">newest right</text>
  </svg>`
}
