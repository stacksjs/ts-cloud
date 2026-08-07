/**
 * Turn the dashboard's topology model into drawable geometry.
 *
 * The layering comes from `@ts-charts/graph` (ts-charts' Sugiyama layout), so
 * the same code runs in the stx `<script server>` block for the first paint and
 * again in `<script client>` when polling brings a changed topology — one
 * layout implementation, no drift between the two paints.
 *
 * Pure: no DOM, no fetch. See `pages/infrastructure/topology.stx`.
 */
// The `/layered` entry rather than the package root: it is pure geometry, so
// the client bundle stays free of selection/drag/zoom, which it never needs.
import { edgePath, layeredLayout } from '@ts-charts/graph/layered'

export type TopologyStatus = 'ok' | 'warn' | 'bad' | 'idle' | 'unknown'
export type TopologyFlow = 'request' | 'async' | 'data' | 'backup'

export interface TopologyFact {
  label: string
  value: string
}

export interface TopologyNode {
  id: string
  label: string
  kind: string
  layer: number
  status: TopologyStatus
  sub?: string
  facts: TopologyFact[]
  href?: string
  group?: string
  external?: boolean
}

export interface TopologyLink {
  source: string
  target: string
  flow: TopologyFlow
  label?: string
  status?: TopologyStatus
}

export interface TopologyModel {
  mode: 'server' | 'serverless'
  project: string
  environment: string
  provider: string
  region: string
  generatedAt: string
  layers: Array<{ index: number, id: string, label: string }>
  groups: Array<{ id: string, label: string, sub?: string }>
  nodes: TopologyNode[]
  links: TopologyLink[]
  notes: string[]
}

export interface GeometryNode extends TopologyNode {
  x: number
  y: number
  width: number
  height: number
  cx: number
  cy: number
  /** Icon path drawn in a 24×24 box at the node's leading edge. */
  icon: string
  /** Ids reachable in one hop, either way — drives hover highlighting. */
  neighbours: string[]
}

export interface GeometryLink extends TopologyLink {
  id: string
  d: string
  labelX: number
  labelY: number
}

export interface GeometryLane {
  id: string
  label: string
  x: number
  y: number
  width: number
  height: number
  count: number
}

export interface GeometryGroup {
  id: string
  label: string
  sub?: string
  x: number
  y: number
  width: number
  height: number
}

export interface TopologyGeometry {
  width: number
  height: number
  nodes: GeometryNode[]
  links: GeometryLink[]
  lanes: GeometryLane[]
  groups: GeometryGroup[]
  /** Layout quality signal from ts-charts — surfaced for diagnostics. */
  crossings: number
}

export interface TopologyGeometryOptions {
  /** Height reserved for the lane captions across the top. */
  laneGutter?: number
  nodeHeight?: number
  layerGap?: number
  nodeGap?: number
}

const NODE_HEIGHT = 64
/** Height reserved above the drawing for the lane captions. */
const LANE_GUTTER = 78
const GROUP_PADDING = 22

function midpoint(a: { x: number, y: number }, b: { x: number, y: number }): { x: number, y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** 24×24 glyphs, one per resource kind. Stroked, so they inherit node colour. */
const ICONS: Record<string, string> = {
  internet: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.4 3.8 5.5 3.8 9S14.5 21.6 12 21c-2.5-2.4-3.8-5.5-3.8-9S9.5 3 12 3z',
  dns: 'M4 7h16M4 12h16M4 17h10M7 4v16',
  waf: 'M12 3l7 3v5c0 4.4-2.9 8.2-7 10-4.1-1.8-7-5.6-7-10V6l7-3z',
  firewall: 'M3 6h18M3 12h18M3 18h18M8 6v6M16 6v6M12 12v6',
  cdn: 'M6 17a4 4 0 010-8 5.5 5.5 0 0110.6-1.3A4.2 4.2 0 0118 17H6z',
  gateway: 'M4 8h16M4 16h16M8 4v16M16 4v16',
  proxy: 'M4 6h7l3 3h6M4 18h7l3-3h6M17 6l3 3-3 3M17 12l3 3-3 3',
  site: 'M4 5h16v14H4zM4 9h16M7 7h.01M10 7h.01',
  function: 'M8 5c-2 0-2 3-2 5s-1 2-2 2 1 0 2 2 0 5 2 5M16 5c2 0 2 3 2 5s1 2 2 2-1 0-2 2 0 5-2 5',
  worker: 'M12 9a3 3 0 100 6 3 3 0 000-6zM12 3v3M12 18v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M3 12h3M18 12h3M4.9 19.1L7 17M17 7l2.1-2.1',
  scheduler: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2',
  queue: 'M4 7h16v4H4zM4 13h16v4H4z',
  cache: 'M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  storage: 'M4 6h16v12H4zM4 10h16M8 14h4',
  filesystem: 'M4 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V7z',
  backup: 'M12 5a7 7 0 107 7M12 5V2M12 5l3 3M5 12a7 7 0 002 5',
}
const FALLBACK_ICON = 'M5 5h14v14H5z'

function iconFor(kind: string): string {
  return ICONS[kind] ?? FALLBACK_ICON
}

/** Node boxes size to their content so long service names stay readable. */
function widthFor(node: TopologyNode): number {
  const label = (node.label ?? '').length
  const sub = (node.sub ?? '').length
  const longest = Math.max(label * 8.4, sub * 6.4)
  return Math.round(Math.min(288, Math.max(168, longest + 78)))
}

/**
 * Lay the model out left-to-right in lanes: the internet on the left, the
 * durable stores on the right, one lane per layer.
 *
 * Model layer numbers are sparse — an environment with no WAF and no backups
 * simply has no node on those rows — so used layers are compacted to
 * consecutive ranks first; otherwise the diagram grows empty bands.
 */
export function topologyGeometry(model: TopologyModel, options: TopologyGeometryOptions = {}): TopologyGeometry {
  const laneGutter = options.laneGutter ?? LANE_GUTTER
  const nodeHeight = options.nodeHeight ?? NODE_HEIGHT
  const nodes = Array.isArray(model?.nodes) ? model.nodes : []
  const links = Array.isArray(model?.links) ? model.links : []

  if (!nodes.length)
    return { width: 400, height: laneGutter + 200, nodes: [], links: [], lanes: [], groups: [], crossings: 0 }

  const used = [...new Set(nodes.map((node) => node.layer))].sort((a, b) => a - b)
  const rankOf = new Map(used.map((layer, rank) => [layer, rank]))

  const layout = layeredLayout(
    {
      nodes: nodes.map((node) => ({
        id: node.id,
        layer: rankOf.get(node.layer) ?? 0,
        width: widthFor(node),
        height: nodeHeight,
      })),
      edges: links.map((link) => ({ source: link.source, target: link.target })),
    },
    {
      direction: 'right',
      layerGap: options.layerGap ?? 96,
      nodeGap: options.nodeGap ?? 30,
      padding: 28,
    },
  )

  const placed = new Map(layout.nodes.map((node) => [node.id, node]))
  const neighbours = new Map<string, Set<string>>()
  for (const node of nodes) neighbours.set(node.id, new Set())
  for (const link of links) {
    neighbours.get(link.source)?.add(link.target)
    neighbours.get(link.target)?.add(link.source)
  }

  // Lane captions sit above the drawing, so everything drops by the gutter.
  const shift = laneGutter
  const geometryNodes: GeometryNode[] = nodes.flatMap((node) => {
    const box = placed.get(node.id)
    if (!box) return []
    const y = box.y + shift
    return [{
      ...node,
      x: box.x,
      y,
      width: box.width,
      height: box.height,
      cx: box.x + box.width / 2,
      cy: y + box.height / 2,
      icon: iconFor(node.kind),
      neighbours: [...(neighbours.get(node.id) ?? [])],
    }]
  })

  // Match routed edges back to model links by endpoint rather than by index:
  // the layout drops edges it can't resolve, which would shift a positional
  // pairing and mislabel every link after the first gap.
  const pending = new Map<string, TopologyLink[]>()
  for (const link of links) {
    const key = `${link.source}->${link.target}`
    if (!pending.has(key)) pending.set(key, [])
    pending.get(key)!.push(link)
  }
  const geometryLinks: GeometryLink[] = layout.edges.map((edge) => {
    const source = pending.get(`${edge.source}->${edge.target}`)?.shift()
    const points = edge.points.map((point) => ({ x: point.x, y: point.y + shift }))
    const middle = points.length % 2
      ? points[Math.floor(points.length / 2)]
      : midpoint(points[points.length / 2 - 1], points[points.length / 2])
    return {
      source: edge.source,
      target: edge.target,
      flow: source?.flow ?? 'request',
      label: source?.label,
      status: source?.status,
      id: `${edge.source}->${edge.target}`,
      d: edgePath(points, { curve: 'smooth', direction: 'right' }),
      labelX: middle.x,
      labelY: middle.y - 7,
    }
  })

  const width = layout.width
  const height = layout.height + shift

  // One vertical band per layer, spanning the full drawing height with the
  // caption in the gutter above it.
  const labelOf = new Map((model.layers ?? []).map((layer) => [layer.index, layer.label]))
  const lanes: GeometryLane[] = used.flatMap((layer) => {
    const members = geometryNodes.filter((node) => node.layer === layer)
    if (!members.length) return []
    const left = Math.min(...members.map((node) => node.x))
    const right = Math.max(...members.map((node) => node.x + node.width))
    return [{
      id: `lane-${layer}`,
      label: labelOf.get(layer) ?? `Layer ${layer}`,
      x: left - 16,
      y: shift - 34,
      width: right - left + 32,
      height: height - shift + 46,
      count: members.length,
    }]
  })

  const groups: GeometryGroup[] = (model.groups ?? []).flatMap((group) => {
    const members = geometryNodes.filter((node) => node.group === group.id)
    if (!members.length) return []
    const x = Math.min(...members.map((node) => node.x)) - GROUP_PADDING
    const y = Math.min(...members.map((node) => node.y)) - GROUP_PADDING - 12
    const right = Math.max(...members.map((node) => node.x + node.width)) + GROUP_PADDING
    const bottom = Math.max(...members.map((node) => node.y + node.height)) + GROUP_PADDING
    return [{ ...group, x, y, width: right - x, height: bottom - y }]
  })

  return { width, height, nodes: geometryNodes, links: geometryLinks, lanes, groups, crossings: layout.crossings }
}

/** Node ids whose label, kind or subtitle matches a free-text query. */
export function matchTopology(nodes: GeometryNode[], query: string): Set<string> {
  const needle = query.trim().toLowerCase()
  if (!needle) return new Set(nodes.map((node) => node.id))
  return new Set(
    nodes
      .filter((node) => `${node.label} ${node.kind} ${node.sub ?? ''} ${node.facts.map((fact) => fact.value).join(' ')}`
        .toLowerCase()
        .includes(needle))
      .map((node) => node.id),
  )
}

/**
 * The set to keep bright when a node is focused: the node, everything one hop
 * away, and the full request path back to the internet — which is the question
 * an operator actually has ("what reaches this, and through what?").
 */
export function highlightFor(geometry: TopologyGeometry, id: string | null): Set<string> | null {
  if (!id) return null
  const keep = new Set<string>([id])
  const incoming = new Map<string, string[]>()
  for (const link of geometry.links) {
    if (!incoming.has(link.target)) incoming.set(link.target, [])
    incoming.get(link.target)!.push(link.source)
  }
  const node = geometry.nodes.find((candidate) => candidate.id === id)
  for (const neighbour of node?.neighbours ?? []) keep.add(neighbour)

  const seen = new Set<string>([id])
  const queue = [id]
  while (queue.length) {
    const current = queue.shift()!
    for (const parent of incoming.get(current) ?? []) {
      keep.add(parent)
      if (seen.has(parent)) continue
      seen.add(parent)
      queue.push(parent)
    }
  }
  return keep
}
