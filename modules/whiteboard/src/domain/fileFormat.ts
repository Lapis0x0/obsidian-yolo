// `.yoloboard` schema v1 — the single point that knows this file format.
// See docs/plans/08-25-yolo-whiteboard/p1-design.md §1.1 for the schema this
// formalizes, and p3-canvas-parity.md D5 for why it is shaped the way it is.
//
// The format is a **superset of JSON Canvas 1.0** (https://jsoncanvas.org/
// spec/1.0/). Every concept Canvas has, we spell the way Canvas spells it:
//
//   - one flat `nodes` array holding `text` / `file` / `link` / `group` nodes, rather
//     than a `cards` array beside a separate `groups` collection — a group is
//     a kind of node, not a second population (D5);
//   - `color` is a node (and edge) attribute, with Canvas's `canvasColor`
//     values: the presets "1".."6", or a hex string;
//   - edges name their ends `fromNode`/`toNode`, their anchors
//     `fromSide`/`toSide`, and their arrowheads `fromEnd`/`toEnd`, with
//     Canvas's defaults (no arrow at the source, an arrow at the target).
//
// Two deliberate deviations, both documented in the P3 report:
//   - geometry is `w`/`h`, not Canvas's `width`/`height` (an abbreviation, not
//     a different concept; renaming would churn every geometry helper for no
//     conceptual gain);
//   - we add `version` and `camera` at the top level — the viewport state
//     Canvas cannot hold is one of the reasons this is our own format
//     (master.md's "存储格式" decision).
//
// Everything else Canvas defines but we do not yet render (`subpath` on file
// nodes, `background`/`backgroundStyle` on groups) round-trips untouched
// through the `extra` bag below, so an import loses nothing.
//
// Zero dependencies, no host/DOM/Obsidian imports (Module Boundaries,
// CLAUDE.md): this file is pure data-in, data-out.
//
// Forward compatibility: an unrecognized field at the file, node, or edge
// level is preserved verbatim on parse (in an `extra` bag) and written back
// on serialize, so a future schema addition round-trips through an older
// build of this module without data loss.

export const YOLOBOARD_SCHEMA_VERSION = 1

export type NodeId = string
export type EdgeId = string
export type NodeSide = 'top' | 'right' | 'bottom' | 'left'
/** JSON Canvas's `fromEnd`/`toEnd`: whether that end of an edge is an arrow. */
export type EdgeEnd = 'none' | 'arrow'
/**
 * JSON Canvas's `canvasColor`: one of the six presets ("1".."6") or a hex
 * string ("#FF0000"). Kept as an unconstrained string — an unknown value is
 * preserved rather than dropped, and what a colour *looks* like is the
 * rendering layer's business, not the file format's.
 */
export type NodeColor = string

const NODE_SIDES: readonly NodeSide[] = ['top', 'right', 'bottom', 'left']
const EDGE_ENDS: readonly EdgeEnd[] = ['none', 'arrow']

/** Unrecognized JSON fields captured at a given nesting level, preserved verbatim. */
export type ExtraFields = Readonly<Record<string, unknown>>

export type BoardNodeBase = Readonly<{
  id: NodeId
  x: number
  y: number
  w: number
  h: number
  /** JSON Canvas `color`. Absent = the theme's default for that node kind. */
  color?: NodeColor
  /** Unknown fields read from this node's JSON object, round-tripped on write. */
  extra: ExtraFields
}>

/** JSON Canvas text node: markdown that lives in the board file itself. */
export type TextNode = BoardNodeBase &
  Readonly<{
    type: 'text'
    text: string
  }>

/**
 * JSON Canvas file node: a reference to a vault file. Markdown, image, audio
 * and video files each render as their own kind of card (domain/naming.ts's
 * `fileNodeKind`); every other extension renders as a placeholder until the
 * PDF card lands (M2). One node type rather than the old `note`/`pdf` pair,
 * because "which file is this" is a path question, not a schema question —
 * and Canvas has always modelled it that way.
 */
export type FileNode = BoardNodeBase &
  Readonly<{
    type: 'file'
    /** Vault-relative path to the backing file. */
    file: string
  }>

/**
 * JSON Canvas link node: a web page, embedded live in the card. The one node
 * kind whose content lives outside the vault entirely, which is why it is its
 * own type rather than a file node with an `http` path.
 */
export type LinkNode = BoardNodeBase &
  Readonly<{
    type: 'link'
    url: string
  }>

/**
 * JSON Canvas group node: a labelled frame behind the cards. Membership is
 * geometric (a node inside the frame is in the group) rather than stored, the
 * same way Canvas does it; the interactions that act on membership are P3
 * batch 3.
 */
export type GroupNode = BoardNodeBase &
  Readonly<{
    type: 'group'
    label?: string
  }>

export type BoardNode = TextNode | FileNode | LinkNode | GroupNode

export type Edge = Readonly<{
  id: EdgeId
  fromNode: NodeId
  toNode: NodeId
  /** Anchor side on the source/target node. Omitted = pick from relative position at render time (not this module's job). */
  fromSide?: NodeSide
  toSide?: NodeSide
  /** JSON Canvas defaults: 'none' at the source, 'arrow' at the target. */
  fromEnd: EdgeEnd
  toEnd: EdgeEnd
  color?: NodeColor
  label?: string
  /** Unknown fields read from this edge's JSON object, round-tripped on write. */
  extra: ExtraFields
}>

export type Camera = Readonly<{
  x: number
  y: number
  scale: number
}>

export type Board = Readonly<{
  version: 1
  camera: Camera
  /**
   * Read-only lock: while set, the board can be looked at and moved around
   * but not changed (ui/canvas.ts's `isLocked` gate).
   *
   * A third deliberate deviation from Canvas, alongside `camera`. Canvas keeps
   * its lock out of the `.canvas` file too, in a machine-local side store
   * (`app.saveLocalStorage("canvas-" + path)`, verified against 1.13.7) — it
   * has to, because `.canvas` is a shared open format with nowhere to put it.
   * `.yoloboard` is our own format for exactly this class of state, and a lock
   * that lives in the file is one the board carries with it: sync it to
   * another device, or hand it to someone else, and it is still locked. A
   * machine-local lock is invisible everywhere but the machine that set it.
   *
   * Absent rather than `false` when the board is unlocked, so a board that has
   * never been locked serializes exactly as it did before this field existed.
   */
  locked?: boolean
  nodes: readonly BoardNode[]
  edges: readonly Edge[]
  /** Unknown top-level fields, round-tripped on write. */
  extra: ExtraFields
}>

export type BoardParseIssue =
  | Readonly<{ type: 'invalid-json'; message: string }>
  | Readonly<{ type: 'invalid-schema'; message: string }>
  | Readonly<{
      type: 'invalid-node'
      index: number
      id?: string
      message: string
    }>
  | Readonly<{ type: 'duplicate-node-id'; index: number; id: string }>
  | Readonly<{
      type: 'invalid-edge'
      index: number
      id?: string
      message: string
    }>
  | Readonly<{
      type: 'dangling-edge'
      id: string
      from: string
      to: string
    }>

export type BoardParseResult =
  | Readonly<{ ok: true; board: Board; issues: readonly BoardParseIssue[] }>
  | Readonly<{ ok: false; issues: readonly BoardParseIssue[] }>

export const DEFAULT_CAMERA: Camera = Object.freeze({ x: 0, y: 0, scale: 1 })

export function emptyBoard(): Board {
  return {
    version: YOLOBOARD_SCHEMA_VERSION,
    camera: DEFAULT_CAMERA,
    nodes: [],
    edges: [],
    extra: {},
  }
}

/**
 * Parses raw `.yoloboard` file text. An empty/blank file parses to a fresh
 * empty board. A JSON syntax error, a non-object root, an unsupported
 * `version`, or a `nodes`/`edges` field present but not an array makes the
 * whole file unparsable (`ok: false`) — the document cannot be trusted at all
 * in that case. Anything narrower (a single malformed node, a malformed edge,
 * an edge referencing a missing node) is dropped and reported as an issue
 * instead, so one bad record doesn't take down an otherwise-good board.
 */
export function parseBoard(raw: string): BoardParseResult {
  if (!raw.trim()) return { ok: true, board: emptyBoard(), issues: [] }

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
          message: '.yoloboard root must be a JSON object',
        },
      ],
    }
  }

  if (json.version !== undefined && json.version !== YOLOBOARD_SCHEMA_VERSION) {
    return {
      ok: false,
      issues: [
        {
          type: 'invalid-schema',
          message: `Unsupported .yoloboard version: ${describeUnknown(json.version)}`,
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
        {
          type: 'invalid-schema',
          message: '.yoloboard "nodes" must be an array',
        },
      ],
    }
  }
  if (rawEdges !== undefined && !Array.isArray(rawEdges)) {
    return {
      ok: false,
      issues: [
        {
          type: 'invalid-schema',
          message: '.yoloboard "edges" must be an array',
        },
      ],
    }
  }

  const issues: BoardParseIssue[] = []
  const nodes = parseNodes(Array.isArray(rawNodes) ? rawNodes : [], issues)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = parseEdges(
    Array.isArray(rawEdges) ? rawEdges : [],
    nodeIds,
    issues,
  )

  const board: Board = {
    version: YOLOBOARD_SCHEMA_VERSION,
    camera: parseCamera(json.camera),
    // Only a literal `true` locks a board: anything else — absent, false, or
    // a value of the wrong type — is a board that opens editable, which is
    // the safe direction for a field to be misread in.
    ...(json.locked === true ? { locked: true } : {}),
    nodes,
    edges,
    extra: extractExtra(json, TOP_LEVEL_KEYS),
  }
  return { ok: true, board, issues }
}

/** Serializes a board with a stable field order and 2-space indent, so diffs reflect real changes. */
export function serializeBoard(board: Board): string {
  const out: Record<string, unknown> = {
    version: board.version,
    camera: { x: board.camera.x, y: board.camera.y, scale: board.camera.scale },
    // `undefined` is dropped by JSON.stringify, so an unlocked board writes no
    // `locked` key at all rather than a redundant `false`.
    locked: board.locked ? true : undefined,
    nodes: board.nodes.map(serializeNode),
    edges: board.edges.map(serializeEdge),
    ...board.extra,
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

// --- nodes ---------------------------------------------------------------

const NODE_COMMON_KEYS = ['id', 'type', 'x', 'y', 'w', 'h', 'color'] as const
const TEXT_NODE_KEYS = [...NODE_COMMON_KEYS, 'text'] as const
const FILE_NODE_KEYS = [...NODE_COMMON_KEYS, 'file'] as const
const LINK_NODE_KEYS = [...NODE_COMMON_KEYS, 'url'] as const
const GROUP_NODE_KEYS = [...NODE_COMMON_KEYS, 'label'] as const

function parseNodes(
  raw: readonly unknown[],
  issues: BoardParseIssue[],
): BoardNode[] {
  const nodes: BoardNode[] = []
  const seenIds = new Set<string>()
  raw.forEach((entry, index) => {
    const node = parseNode(entry, index, issues)
    if (!node) return
    if (seenIds.has(node.id)) {
      issues.push({ type: 'duplicate-node-id', index, id: node.id })
      return
    }
    seenIds.add(node.id)
    nodes.push(node)
  })
  return nodes
}

function parseNode(
  entry: unknown,
  index: number,
  issues: BoardParseIssue[],
): BoardNode | null {
  if (!isPlainObject(entry)) {
    issues.push({
      type: 'invalid-node',
      index,
      message: 'Node must be a JSON object',
    })
    return null
  }
  const id = entry.id
  if (typeof id !== 'string' || id.length === 0) {
    issues.push({
      type: 'invalid-node',
      index,
      message: 'Node "id" must be a non-empty string',
    })
    return null
  }
  const base = parseNodeGeometry(entry, index, id, issues)
  if (!base) return null

  switch (entry.type) {
    case 'text': {
      const text = entry.text
      if (typeof text !== 'string') {
        issues.push({
          type: 'invalid-node',
          index,
          id,
          message: 'Text node requires "text" to be a string',
        })
        return null
      }
      return {
        ...base,
        type: 'text',
        text,
        extra: extractExtra(entry, TEXT_NODE_KEYS),
      }
    }
    case 'file': {
      const file = entry.file
      if (typeof file !== 'string' || file.length === 0) {
        issues.push({
          type: 'invalid-node',
          index,
          id,
          message: 'File node requires a non-empty "file"',
        })
        return null
      }
      return {
        ...base,
        type: 'file',
        file,
        extra: extractExtra(entry, FILE_NODE_KEYS),
      }
    }
    case 'link': {
      const url = entry.url
      if (typeof url !== 'string' || url.length === 0) {
        issues.push({
          type: 'invalid-node',
          index,
          id,
          message: 'Link node requires a non-empty "url"',
        })
        return null
      }
      return {
        ...base,
        type: 'link',
        url,
        extra: extractExtra(entry, LINK_NODE_KEYS),
      }
    }
    case 'group': {
      const label = typeof entry.label === 'string' ? entry.label : undefined
      return {
        ...base,
        type: 'group',
        ...(label === undefined ? {} : { label }),
        extra: extractExtra(entry, GROUP_NODE_KEYS),
      }
    }
    default:
      issues.push({
        type: 'invalid-node',
        index,
        id,
        message: `Unknown node "type": ${String(entry.type)}`,
      })
      return null
  }
}

function parseNodeGeometry(
  entry: Record<string, unknown>,
  index: number,
  id: string,
  issues: BoardParseIssue[],
): Omit<BoardNodeBase, 'extra'> | null {
  const { x, y, w, h } = entry
  if (![x, y, w, h].every(isFiniteNumber)) {
    issues.push({
      type: 'invalid-node',
      index,
      id,
      message: 'Node "x"/"y"/"w"/"h" must be finite numbers',
    })
    return null
  }
  const color = isNonEmptyString(entry.color) ? entry.color : undefined
  return {
    id,
    x: x as number,
    y: y as number,
    w: w as number,
    h: h as number,
    ...(color === undefined ? {} : { color }),
  }
}

function serializeNode(node: BoardNode): Record<string, unknown> {
  const common = {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
    color: node.color,
  }
  switch (node.type) {
    case 'text':
      return { ...common, text: node.text, ...node.extra }
    case 'file':
      return { ...common, file: node.file, ...node.extra }
    case 'link':
      return { ...common, url: node.url, ...node.extra }
    case 'group':
      return { ...common, label: node.label, ...node.extra }
  }
}

// --- edges -----------------------------------------------------------------

const EDGE_KNOWN_KEYS = [
  'id',
  'fromNode',
  'toNode',
  'fromSide',
  'toSide',
  'fromEnd',
  'toEnd',
  'color',
  'label',
] as const

function parseEdges(
  raw: readonly unknown[],
  nodeIds: ReadonlySet<string>,
  issues: BoardParseIssue[],
): Edge[] {
  const edges: Edge[] = []
  const seenIds = new Set<string>()
  raw.forEach((entry, index) => {
    const edge = parseEdge(entry, index, issues)
    if (!edge) return
    if (seenIds.has(edge.id)) {
      issues.push({
        type: 'invalid-edge',
        index,
        id: edge.id,
        message: 'Duplicate edge id',
      })
      return
    }
    if (!nodeIds.has(edge.fromNode) || !nodeIds.has(edge.toNode)) {
      issues.push({
        type: 'dangling-edge',
        id: edge.id,
        from: edge.fromNode,
        to: edge.toNode,
      })
      return
    }
    seenIds.add(edge.id)
    edges.push(edge)
  })
  return edges
}

function parseEdge(
  entry: unknown,
  index: number,
  issues: BoardParseIssue[],
): Edge | null {
  if (!isPlainObject(entry)) {
    issues.push({
      type: 'invalid-edge',
      index,
      message: 'Edge must be a JSON object',
    })
    return null
  }
  const { id, fromNode, toNode } = entry
  if (typeof id !== 'string' || id.length === 0) {
    issues.push({
      type: 'invalid-edge',
      index,
      message: 'Edge "id" must be a non-empty string',
    })
    return null
  }
  if (
    typeof fromNode !== 'string' ||
    fromNode.length === 0 ||
    typeof toNode !== 'string' ||
    toNode.length === 0
  ) {
    issues.push({
      type: 'invalid-edge',
      index,
      id,
      message: 'Edge "fromNode"/"toNode" must be non-empty node ids',
    })
    return null
  }
  const fromSide = isNodeSide(entry.fromSide) ? entry.fromSide : undefined
  const toSide = isNodeSide(entry.toSide) ? entry.toSide : undefined
  // JSON Canvas defaults, applied here so nothing downstream has to know them.
  const fromEnd = isEdgeEnd(entry.fromEnd) ? entry.fromEnd : 'none'
  const toEnd = isEdgeEnd(entry.toEnd) ? entry.toEnd : 'arrow'
  const color = isNonEmptyString(entry.color) ? entry.color : undefined
  const label = typeof entry.label === 'string' ? entry.label : undefined
  return {
    id,
    fromNode,
    toNode,
    fromSide,
    toSide,
    fromEnd,
    toEnd,
    color,
    label,
    extra: extractExtra(entry, EDGE_KNOWN_KEYS),
  }
}

function serializeEdge(edge: Edge): Record<string, unknown> {
  return {
    id: edge.id,
    fromNode: edge.fromNode,
    toNode: edge.toNode,
    fromSide: edge.fromSide,
    toSide: edge.toSide,
    fromEnd: edge.fromEnd,
    toEnd: edge.toEnd,
    color: edge.color,
    label: edge.label,
    ...edge.extra,
  }
}

// --- camera ------------------------------------------------------------

function parseCamera(raw: unknown): Camera {
  if (!isPlainObject(raw)) return DEFAULT_CAMERA
  return {
    x: isFiniteNumber(raw.x) ? raw.x : DEFAULT_CAMERA.x,
    y: isFiniteNumber(raw.y) ? raw.y : DEFAULT_CAMERA.y,
    scale: isFiniteNumber(raw.scale) ? raw.scale : DEFAULT_CAMERA.scale,
  }
}

// --- shared helpers ------------------------------------------------------

const TOP_LEVEL_KEYS = [
  'version',
  'camera',
  'locked',
  'nodes',
  'edges',
] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Renders an `unknown` value for an error message without risking `[object Object]`. */
function describeUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return String(value)
  }
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return json
  } catch {
    // fall through to the generic description below
  }
  return Object.prototype.toString.call(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function isNodeSide(value: unknown): value is NodeSide {
  return (
    typeof value === 'string' &&
    (NODE_SIDES as readonly string[]).includes(value)
  )
}

export function isEdgeEnd(value: unknown): value is EdgeEnd {
  return (
    typeof value === 'string' &&
    (EDGE_ENDS as readonly string[]).includes(value)
  )
}

function extractExtra(
  raw: Record<string, unknown>,
  knownKeys: readonly string[],
): ExtraFields {
  const extra: Record<string, unknown> = {}
  for (const key of Object.keys(raw)) {
    if (!knownKeys.includes(key)) extra[key] = raw[key]
  }
  return extra
}
