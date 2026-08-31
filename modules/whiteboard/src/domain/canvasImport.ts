// One-way `.canvas` -> `.yoloboard` conversion (docs/plans/
// 08-25-yolo-whiteboard/p3-canvas-parity.md D4). Import only: we never write
// `.canvas`, never register a view for it, and never touch the source file.
//
// The mapping is close to the identity function, which is the whole reason
// D5 realigned our schema onto JSON Canvas's concepts first. What is *not*
// identity, and why:
//
//   - `width`/`height` -> `w`/`h`. An abbreviation, not a concept (see
//     fileFormat.ts's header).
//   - a `link` node -> a text node holding `<url>`. We have no web card until
//     P3 batch 2; a text node keeps the URL visible and clickable with no new
//     concept, where a `link` node type nothing renders would be a card that
//     shows nothing. The node's kind is the only thing lost.
//   - `.canvas` has no camera. A board opened at the file's stored camera
//     would otherwise start at world origin, which for a canvas laid out in
//     negative coordinates is empty space — so the import parks the camera on
//     the imported content's top-left corner (see `cameraForBounds`).
//
// Everything else is carried through untouched, including the fields we do
// not render yet: a file node's `subpath`, a group's `background`/
// `backgroundStyle`, and any other unknown key all land in the node's `extra`
// bag and are written back verbatim (fileFormat.ts's forward-compatibility
// rule). Node and edge ids are reused as-is, so an imported board's edges
// point at exactly the ids the `.canvas` used.
//
// Dependency-free like every other domain/ module.

import {
  type Board,
  type BoardNode,
  type Camera,
  type Edge,
  YOLOBOARD_SCHEMA_VERSION,
  isEdgeEnd,
  isNodeSide,
} from './fileFormat'

export type CanvasImportIssue =
  | Readonly<{ type: 'invalid-json'; message: string }>
  | Readonly<{ type: 'invalid-schema'; message: string }>
  | Readonly<{
      type: 'skipped-node'
      index: number
      id?: string
      reason: string
    }>
  | Readonly<{
      type: 'skipped-edge'
      index: number
      id?: string
      reason: string
    }>

export type CanvasImportResult =
  | Readonly<{
      ok: true
      board: Board
      /** Per-kind counts of what was actually imported, for the notice. */
      counts: Readonly<{ nodes: number; edges: number }>
      issues: readonly CanvasImportIssue[]
    }>
  | Readonly<{ ok: false; issues: readonly CanvasImportIssue[] }>

/** Screen-space gap between the viewport's top-left and the imported content. */
const IMPORT_CAMERA_MARGIN_PX = 48

/**
 * Converts one `.canvas` file's raw text into a `Board`. A malformed file
 * fails outright (`ok: false`); a single unusable node or edge is skipped and
 * reported, the same tolerance `parseBoard` applies to a `.yoloboard`.
 */
export function importCanvas(raw: string): CanvasImportResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          type: 'invalid-json',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  }
  if (!isPlainObject(json)) {
    return {
      ok: false,
      issues: [
        {
          type: 'invalid-schema',
          message: '.canvas root must be a JSON object',
        },
      ],
    }
  }

  const rawNodes = json.nodes
  const rawEdges = json.edges
  if (rawNodes !== undefined && !Array.isArray(rawNodes)) {
    return {
      ok: false,
      issues: [
        { type: 'invalid-schema', message: '.canvas "nodes" must be an array' },
      ],
    }
  }
  if (rawEdges !== undefined && !Array.isArray(rawEdges)) {
    return {
      ok: false,
      issues: [
        { type: 'invalid-schema', message: '.canvas "edges" must be an array' },
      ],
    }
  }

  const issues: CanvasImportIssue[] = []
  const nodes = convertNodes(Array.isArray(rawNodes) ? rawNodes : [], issues)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = convertEdges(
    Array.isArray(rawEdges) ? rawEdges : [],
    nodeIds,
    issues,
  )

  return {
    ok: true,
    board: {
      version: YOLOBOARD_SCHEMA_VERSION,
      camera: cameraForBounds(nodes),
      nodes,
      edges,
      extra: {},
    },
    counts: { nodes: nodes.length, edges: edges.length },
    issues,
  }
}

/**
 * The camera that puts the imported content's top-left corner just inside the
 * viewport at 1:1 zoom. `camera.x`/`y` are the world layer's screen
 * translation (domain/camera.ts's `viewFromCamera`), so this is the world
 * origin's screen position, not a world coordinate.
 */
function cameraForBounds(nodes: readonly BoardNode[]): Camera {
  if (nodes.length === 0) return { x: 0, y: 0, scale: 1 }
  const minX = Math.min(...nodes.map((node) => node.x))
  const minY = Math.min(...nodes.map((node) => node.y))
  return {
    x: IMPORT_CAMERA_MARGIN_PX - minX,
    y: IMPORT_CAMERA_MARGIN_PX - minY,
    scale: 1,
  }
}

function convertNodes(
  raw: readonly unknown[],
  issues: CanvasImportIssue[],
): BoardNode[] {
  const nodes: BoardNode[] = []
  const seenIds = new Set<string>()
  raw.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      issues.push({ type: 'skipped-node', index, reason: 'not a JSON object' })
      return
    }
    const id = entry.id
    if (typeof id !== 'string' || id.length === 0) {
      issues.push({ type: 'skipped-node', index, reason: 'missing "id"' })
      return
    }
    if (seenIds.has(id)) {
      issues.push({ type: 'skipped-node', index, id, reason: 'duplicate "id"' })
      return
    }
    const geometry = convertGeometry(entry)
    if (!geometry) {
      issues.push({
        type: 'skipped-node',
        index,
        id,
        reason: 'missing or non-numeric x/y/width/height',
      })
      return
    }
    const base = {
      id,
      ...geometry,
      ...(isNonEmptyString(entry.color) ? { color: entry.color } : {}),
    }
    const node = convertNodeBody(entry, base, index, id, issues)
    if (!node) return
    seenIds.add(id)
    nodes.push(node)
  })
  return nodes
}

function convertNodeBody(
  entry: Record<string, unknown>,
  base: Omit<BoardNode, 'type' | 'extra'>,
  index: number,
  id: string,
  issues: CanvasImportIssue[],
): BoardNode | null {
  switch (entry.type) {
    case 'text': {
      if (typeof entry.text !== 'string') {
        issues.push({
          type: 'skipped-node',
          index,
          id,
          reason: 'text node has no "text"',
        })
        return null
      }
      return {
        ...base,
        type: 'text',
        text: entry.text,
        extra: extraExcept(entry, [
          'id',
          'type',
          'x',
          'y',
          'width',
          'height',
          'color',
          'text',
        ]),
      }
    }
    case 'file': {
      if (!isNonEmptyString(entry.file)) {
        issues.push({
          type: 'skipped-node',
          index,
          id,
          reason: 'file node has no "file"',
        })
        return null
      }
      return {
        ...base,
        type: 'file',
        file: entry.file,
        // `subpath` is deliberately not consumed yet: it round-trips here and
        // becomes meaningful when card rendering learns to scope to a heading.
        extra: extraExcept(entry, [
          'id',
          'type',
          'x',
          'y',
          'width',
          'height',
          'color',
          'file',
        ]),
      }
    }
    case 'link': {
      if (!isNonEmptyString(entry.url)) {
        issues.push({
          type: 'skipped-node',
          index,
          id,
          reason: 'link node has no "url"',
        })
        return null
      }
      return {
        ...base,
        type: 'text',
        // An autolink rather than the bare URL: this is what makes the address
        // both readable and clickable once the card renders it as markdown.
        text: `<${entry.url}>`,
        extra: extraExcept(entry, [
          'id',
          'type',
          'x',
          'y',
          'width',
          'height',
          'color',
          'url',
        ]),
      }
    }
    case 'group': {
      const label = typeof entry.label === 'string' ? entry.label : undefined
      return {
        ...base,
        type: 'group',
        ...(label === undefined ? {} : { label }),
        extra: extraExcept(entry, [
          'id',
          'type',
          'x',
          'y',
          'width',
          'height',
          'color',
          'label',
        ]),
      }
    }
    default:
      issues.push({
        type: 'skipped-node',
        index,
        id,
        reason: `unknown node type "${String(entry.type)}"`,
      })
      return null
  }
}

function convertGeometry(
  entry: Record<string, unknown>,
): Readonly<{ x: number; y: number; w: number; h: number }> | null {
  const { x, y, width, height } = entry
  if (![x, y, width, height].every(isFiniteNumber)) return null
  return {
    x: x as number,
    y: y as number,
    w: width as number,
    h: height as number,
  }
}

function convertEdges(
  raw: readonly unknown[],
  nodeIds: ReadonlySet<string>,
  issues: CanvasImportIssue[],
): Edge[] {
  const edges: Edge[] = []
  const seenIds = new Set<string>()
  raw.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      issues.push({ type: 'skipped-edge', index, reason: 'not a JSON object' })
      return
    }
    const { id, fromNode, toNode } = entry
    if (typeof id !== 'string' || id.length === 0) {
      issues.push({ type: 'skipped-edge', index, reason: 'missing "id"' })
      return
    }
    if (seenIds.has(id)) {
      issues.push({ type: 'skipped-edge', index, id, reason: 'duplicate "id"' })
      return
    }
    if (!isNonEmptyString(fromNode) || !isNonEmptyString(toNode)) {
      issues.push({
        type: 'skipped-edge',
        index,
        id,
        reason: 'missing "fromNode"/"toNode"',
      })
      return
    }
    // A node we could not import takes its edges with it: a `.yoloboard` with
    // a dangling edge does not parse back (fileFormat.ts), so writing one
    // would produce a file we could not reopen.
    if (!nodeIds.has(fromNode) || !nodeIds.has(toNode)) {
      issues.push({
        type: 'skipped-edge',
        index,
        id,
        reason: 'endpoint node was not imported',
      })
      return
    }
    seenIds.add(id)
    edges.push({
      id,
      fromNode,
      toNode,
      fromSide: isNodeSide(entry.fromSide) ? entry.fromSide : undefined,
      toSide: isNodeSide(entry.toSide) ? entry.toSide : undefined,
      fromEnd: isEdgeEnd(entry.fromEnd) ? entry.fromEnd : 'none',
      toEnd: isEdgeEnd(entry.toEnd) ? entry.toEnd : 'arrow',
      color: isNonEmptyString(entry.color) ? entry.color : undefined,
      label: typeof entry.label === 'string' ? entry.label : undefined,
      extra: extraExcept(entry, [
        'id',
        'fromNode',
        'toNode',
        'fromSide',
        'toSide',
        'fromEnd',
        'toEnd',
        'color',
        'label',
      ]),
    })
  })
  return edges
}

function extraExcept(
  raw: Record<string, unknown>,
  consumed: readonly string[],
): Readonly<Record<string, unknown>> {
  const extra: Record<string, unknown> = {}
  for (const key of Object.keys(raw)) {
    if (!consumed.includes(key)) extra[key] = raw[key]
  }
  return extra
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
