// `.yoloboard` schema v1 — the single point that knows this file format.
// See docs/plans/08-25-yolo-whiteboard/p1-design.md §1.1 for the schema
// this formalizes (the S3 spike's fileFormat.ts, `git show
// spike/s2-editor-lifecycle:src/features/whiteboard-spike/fileFormat.ts`,
// covered only cards with no edges — this is the real, versioned schema).
//
// Zero dependencies, no host/DOM/Obsidian imports (Module Boundaries,
// CLAUDE.md): this file is pure data-in, data-out.
//
// Forward compatibility: an unrecognized field at the file, card, or edge
// level is preserved verbatim on parse (in an `extra` bag) and written back
// on serialize, so a future schema addition round-trips through an older
// build of this module without data loss.

export const YOLOBOARD_SCHEMA_VERSION = 1

export type CardId = string
export type EdgeId = string
export type CardSide = 'top' | 'right' | 'bottom' | 'left'
export type EdgeArrow = 'none' | 'end' | 'both'

const CARD_SIDES: readonly CardSide[] = ['top', 'right', 'bottom', 'left']
const EDGE_ARROWS: readonly EdgeArrow[] = ['none', 'end', 'both']

/** Unrecognized JSON fields captured at a given nesting level, preserved verbatim. */
export type ExtraFields = Readonly<Record<string, unknown>>

export type CardBase = Readonly<{
  id: CardId
  x: number
  y: number
  w: number
  h: number
  /** Unknown fields read from this card's JSON object, round-tripped on write. */
  extra: ExtraFields
}>

export type NoteCard = CardBase &
  Readonly<{
    type: 'note'
    /** Vault-relative path to the backing note. */
    file: string
  }>

export type TextCard = CardBase &
  Readonly<{
    type: 'text'
    markdown: string
  }>

export type PdfCard = CardBase &
  Readonly<{
    type: 'pdf'
    /** Vault-relative path to the backing PDF. */
    file: string
    /** 1-based current page. */
    page: number
  }>

export type BoardCard = NoteCard | TextCard | PdfCard

export type Edge = Readonly<{
  id: EdgeId
  from: CardId
  to: CardId
  /** Anchor side on the source/target card. Omitted = pick from relative position at render time (not this module's job). */
  fromSide?: CardSide
  toSide?: CardSide
  /** Defaults to 'end' when omitted from the file. */
  arrow: EdgeArrow
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
  cards: readonly BoardCard[]
  edges: readonly Edge[]
  /** Reserved, unimplemented in 1.0 (p1-design §1.1) — carried through opaque. */
  groups: readonly unknown[]
  /** Unknown top-level fields, round-tripped on write. */
  extra: ExtraFields
}>

export type BoardParseIssue =
  | Readonly<{ type: 'invalid-json'; message: string }>
  | Readonly<{ type: 'invalid-schema'; message: string }>
  | Readonly<{ type: 'invalid-card'; index: number; id?: string; message: string }>
  | Readonly<{ type: 'duplicate-card-id'; index: number; id: string }>
  | Readonly<{ type: 'invalid-edge'; index: number; id?: string; message: string }>
  | Readonly<{
      type: 'dangling-edge'
      id: string
      from: string
      to: string
    }>

export type BoardParseResult =
  | Readonly<{ ok: true; board: Board; issues: readonly BoardParseIssue[] }>
  | Readonly<{ ok: false; issues: readonly BoardParseIssue[] }>

const DEFAULT_CAMERA: Camera = Object.freeze({ x: 0, y: 0, scale: 1 })

export function emptyBoard(): Board {
  return {
    version: YOLOBOARD_SCHEMA_VERSION,
    camera: DEFAULT_CAMERA,
    cards: [],
    edges: [],
    groups: [],
    extra: {},
  }
}

/**
 * Parses raw `.yoloboard` file text. An empty/blank file parses to a fresh
 * empty board. A JSON syntax error, a non-object root, an unsupported
 * `version`, or a `cards`/`edges`/`groups` field present but not an array
 * makes the whole file unparsable (`ok: false`) — the document cannot be
 * trusted at all in that case. Anything narrower (a single malformed card,
 * a malformed edge, an edge referencing a missing card) is dropped and
 * reported as an issue instead, so one bad record doesn't take down an
 * otherwise-good board.
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
      issues: [{ type: 'invalid-schema', message: '.yoloboard root must be a JSON object' }],
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

  const rawCards = json.cards
  const rawEdges = json.edges
  const rawGroups = json.groups
  if (rawCards !== undefined && !Array.isArray(rawCards)) {
    return {
      ok: false,
      issues: [{ type: 'invalid-schema', message: '.yoloboard "cards" must be an array' }],
    }
  }
  if (rawEdges !== undefined && !Array.isArray(rawEdges)) {
    return {
      ok: false,
      issues: [{ type: 'invalid-schema', message: '.yoloboard "edges" must be an array' }],
    }
  }
  if (rawGroups !== undefined && !Array.isArray(rawGroups)) {
    return {
      ok: false,
      issues: [{ type: 'invalid-schema', message: '.yoloboard "groups" must be an array' }],
    }
  }

  const issues: BoardParseIssue[] = []
  const cards = parseCards(Array.isArray(rawCards) ? rawCards : [], issues)
  const cardIds = new Set(cards.map((card) => card.id))
  const edges = parseEdges(Array.isArray(rawEdges) ? rawEdges : [], cardIds, issues)

  const board: Board = {
    version: YOLOBOARD_SCHEMA_VERSION,
    camera: parseCamera(json.camera),
    cards,
    edges,
    groups: Array.isArray(rawGroups) ? rawGroups : [],
    extra: extractExtra(json, TOP_LEVEL_KEYS),
  }
  return { ok: true, board, issues }
}

/** Serializes a board with a stable field order and 2-space indent, so diffs reflect real changes. */
export function serializeBoard(board: Board): string {
  const out: Record<string, unknown> = {
    version: board.version,
    camera: { x: board.camera.x, y: board.camera.y, scale: board.camera.scale },
    cards: board.cards.map(serializeCard),
    edges: board.edges.map(serializeEdge),
    groups: board.groups,
    ...board.extra,
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

// --- cards ---------------------------------------------------------------

const CARD_COMMON_KEYS = ['id', 'type', 'x', 'y', 'w', 'h'] as const
const NOTE_CARD_KEYS = [...CARD_COMMON_KEYS, 'file'] as const
const TEXT_CARD_KEYS = [...CARD_COMMON_KEYS, 'markdown'] as const
const PDF_CARD_KEYS = [...CARD_COMMON_KEYS, 'file', 'page'] as const

function parseCards(
  raw: readonly unknown[],
  issues: BoardParseIssue[],
): BoardCard[] {
  const cards: BoardCard[] = []
  const seenIds = new Set<string>()
  raw.forEach((entry, index) => {
    const card = parseCard(entry, index, issues)
    if (!card) return
    if (seenIds.has(card.id)) {
      issues.push({ type: 'duplicate-card-id', index, id: card.id })
      return
    }
    seenIds.add(card.id)
    cards.push(card)
  })
  return cards
}

function parseCard(
  entry: unknown,
  index: number,
  issues: BoardParseIssue[],
): BoardCard | null {
  if (!isPlainObject(entry)) {
    issues.push({ type: 'invalid-card', index, message: 'Card must be a JSON object' })
    return null
  }
  const id = entry.id
  if (typeof id !== 'string' || id.length === 0) {
    issues.push({ type: 'invalid-card', index, message: 'Card "id" must be a non-empty string' })
    return null
  }
  const base = parseCardGeometry(entry, index, id, issues)
  if (!base) return null

  switch (entry.type) {
    case 'note': {
      const file = entry.file
      if (typeof file !== 'string' || file.length === 0) {
        issues.push({ type: 'invalid-card', index, id, message: 'Note card requires a non-empty "file"' })
        return null
      }
      return {
        ...base,
        type: 'note',
        file,
        extra: extractExtra(entry, NOTE_CARD_KEYS),
      }
    }
    case 'text': {
      const markdown = entry.markdown
      if (typeof markdown !== 'string') {
        issues.push({ type: 'invalid-card', index, id, message: 'Text card requires "markdown" to be a string' })
        return null
      }
      return {
        ...base,
        type: 'text',
        markdown,
        extra: extractExtra(entry, TEXT_CARD_KEYS),
      }
    }
    case 'pdf': {
      const file = entry.file
      const page = entry.page
      if (typeof file !== 'string' || file.length === 0) {
        issues.push({ type: 'invalid-card', index, id, message: 'PDF card requires a non-empty "file"' })
        return null
      }
      if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
        issues.push({ type: 'invalid-card', index, id, message: 'PDF card requires "page" to be an integer >= 1' })
        return null
      }
      return {
        ...base,
        type: 'pdf',
        file,
        page,
        extra: extractExtra(entry, PDF_CARD_KEYS),
      }
    }
    default:
      issues.push({ type: 'invalid-card', index, id, message: `Unknown card "type": ${String(entry.type)}` })
      return null
  }
}

function parseCardGeometry(
  entry: Record<string, unknown>,
  index: number,
  id: string,
  issues: BoardParseIssue[],
): Omit<CardBase, 'extra'> | null {
  const { x, y, w, h } = entry
  if (![x, y, w, h].every(isFiniteNumber)) {
    issues.push({ type: 'invalid-card', index, id, message: 'Card "x"/"y"/"w"/"h" must be finite numbers' })
    return null
  }
  return { id, x: x as number, y: y as number, w: w as number, h: h as number }
}

function serializeCard(card: BoardCard): Record<string, unknown> {
  const common = { id: card.id, type: card.type, x: card.x, y: card.y, w: card.w, h: card.h }
  switch (card.type) {
    case 'note':
      return { ...common, file: card.file, ...card.extra }
    case 'text':
      return { ...common, markdown: card.markdown, ...card.extra }
    case 'pdf':
      return { ...common, file: card.file, page: card.page, ...card.extra }
  }
}

// --- edges -----------------------------------------------------------------

const EDGE_KNOWN_KEYS = ['id', 'from', 'to', 'fromSide', 'toSide', 'arrow', 'label'] as const

function parseEdges(
  raw: readonly unknown[],
  cardIds: ReadonlySet<string>,
  issues: BoardParseIssue[],
): Edge[] {
  const edges: Edge[] = []
  const seenIds = new Set<string>()
  raw.forEach((entry, index) => {
    const edge = parseEdge(entry, index, issues)
    if (!edge) return
    if (seenIds.has(edge.id)) {
      issues.push({ type: 'invalid-edge', index, id: edge.id, message: 'Duplicate edge id' })
      return
    }
    if (!cardIds.has(edge.from) || !cardIds.has(edge.to)) {
      issues.push({ type: 'dangling-edge', id: edge.id, from: edge.from, to: edge.to })
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
    issues.push({ type: 'invalid-edge', index, message: 'Edge must be a JSON object' })
    return null
  }
  const { id, from, to } = entry
  if (typeof id !== 'string' || id.length === 0) {
    issues.push({ type: 'invalid-edge', index, message: 'Edge "id" must be a non-empty string' })
    return null
  }
  if (typeof from !== 'string' || from.length === 0 || typeof to !== 'string' || to.length === 0) {
    issues.push({ type: 'invalid-edge', index, id, message: 'Edge "from"/"to" must be non-empty card ids' })
    return null
  }
  const fromSide = isCardSide(entry.fromSide) ? entry.fromSide : undefined
  const toSide = isCardSide(entry.toSide) ? entry.toSide : undefined
  const arrow = isEdgeArrow(entry.arrow) ? entry.arrow : 'end'
  const label = typeof entry.label === 'string' ? entry.label : undefined
  return {
    id,
    from,
    to,
    fromSide,
    toSide,
    arrow,
    label,
    extra: extractExtra(entry, EDGE_KNOWN_KEYS),
  }
}

function serializeEdge(edge: Edge): Record<string, unknown> {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    fromSide: edge.fromSide,
    toSide: edge.toSide,
    arrow: edge.arrow,
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

const TOP_LEVEL_KEYS = ['version', 'camera', 'cards', 'edges', 'groups'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Renders an `unknown` value for an error message without risking `[object Object]`. */
function describeUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
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

function isCardSide(value: unknown): value is CardSide {
  return typeof value === 'string' && (CARD_SIDES as readonly string[]).includes(value)
}

function isEdgeArrow(value: unknown): value is EdgeArrow {
  return typeof value === 'string' && (EDGE_ARROWS as readonly string[]).includes(value)
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
