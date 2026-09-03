// One agent edit, applied to a board (docs/plans/09-03-whiteboard-agent-tools
// master.md D2).
//
// `edit_board` takes six arrays — delete, create, update, connect, group,
// arrange — and this is what they mean. Three properties hold it together.
//
// **Fixed order, not call order.** The arrays run 删 → 建 → 改 → 连 → 组 → 排
// regardless of how the model wrote them, so "add three cards, connect them,
// group them, tidy them" is one call rather than four. The order is the one
// that makes each stage able to name what the previous stage produced, and it
// removes an entire class of question the model would otherwise have to think
// about ("do I have to send these separately?").
//
// **All or nothing.** Any invalid operation aborts the whole edit and nothing
// is written. A half-applied edit is the worst outcome available here: the
// model believes it did one thing, the board holds another, and the next edit
// is written against a board neither of them has seen.
//
// **Pure.** Board in, board out, no host, no I/O, no clock — even the ids come
// in through `BoardEditContext`. The CAS write, the file reads, and the
// notice all live in `host/tools.ts`; what is worth testing exhaustively is
// here, where a test is three lines.
//
// There is no `disconnect` and no `ungroup`, because `delete` already is
// both: ids say what they are, and a group is a node, so deleting it dissolves
// it while leaving its members alone.

import {
  ALIGN_EDGES,
  type AlignEdge,
  type ArrangeRect,
  DISTRIBUTE_AXES,
  type DistributeAxis,
  alignRects,
  distributeRects,
} from './arrange'
import { resolveColor } from './color'
import type {
  Board,
  BoardNode,
  EdgeId,
  FileNode,
  GroupNode,
  LinkNode,
  NodeColor,
  NodeId,
  NodeSide,
  TextNode,
} from './fileFormat'
import { isNodeSide } from './fileFormat'
import { groupRectForNodes } from './groups'
import {
  addEdge,
  addNode,
  removeEdge,
  removeNode,
  setNodePositions,
  updateEdge,
  updateNode,
} from './operations'
import {
  type PlacementDirection,
  type Point,
  type Rect,
  type Size,
  collectObstacles,
  placeCard,
} from './placement'
import { tidyRects } from './tidy'

/**
 * The six preset colours, by the name they actually have. JSON Canvas stores
 * them as "1".."6", which is fine for a file and useless to a model — nothing
 * about `"color": "3"` says yellow. The names are Obsidian's own palette
 * (domain/color.ts's `PRESET_HEX`), so this is a spelling, not a new concept.
 */
const COLOR_NAMES: Readonly<Record<string, NodeColor>> = Object.freeze({
  red: '1',
  orange: '2',
  yellow: '3',
  green: '4',
  cyan: '5',
  purple: '6',
})

export const COLOR_NAME_LIST = Object.keys(COLOR_NAMES)

export type BoardEditContext = Readonly<{
  /**
   * Ids are minted against the board *as it stands at that moment*, not
   * against the one this edit started from: two cards created in the same
   * call have to see each other, or they can be handed the same short id.
   */
  newNodeId(board: Board): NodeId
  newEdgeId(board: Board): EdgeId
  /** Snap step for `arrange: "tidy"` — the canvas's `GRID_WORLD_STEP_PX`. */
  gridStep: number
  /** Default size of a text card, and of a card that embeds something. */
  textCardSize: Size
  embedCardSize: Size
}>

/** Exactly one of `text` / `file` / `url` says what kind of card this is. */
export type CreateCardOp = Readonly<{
  text?: string
  file?: string
  url?: string
  x?: number
  y?: number
  w?: number
  h?: number
  color?: string
  /**
   * Card to place this one beside. Absent: beside the card the same call
   * created before it, so a batch flows into a row instead of a pile; absent
   * on the first card too, beside everything already on the board.
   */
  anchor?: NodeId
  direction?: PlacementDirection
}>

export type UpdateOp = Readonly<{
  id: string
  text?: string
  label?: string
  x?: number
  y?: number
  w?: number
  h?: number
  color?: string
}>

export type ConnectOp = Readonly<{
  from: NodeId
  to: NodeId
  label?: string
  color?: string
  fromSide?: string
  toSide?: string
}>

export type GroupOp = Readonly<{
  ids: readonly NodeId[]
  label?: string
}>

export type ArrangeAction = AlignEdge | DistributeAxis | 'tidy'

export const ARRANGE_ACTIONS: readonly ArrangeAction[] = [
  'tidy',
  ...ALIGN_EDGES,
  ...DISTRIBUTE_AXES,
]

export type ArrangeOp = Readonly<{
  ids: readonly NodeId[]
  action: ArrangeAction
}>

export type BoardEdit = Readonly<{
  delete?: readonly string[]
  create?: readonly CreateCardOp[]
  update?: readonly UpdateOp[]
  connect?: readonly ConnectOp[]
  group?: readonly GroupOp[]
  arrange?: readonly ArrangeOp[]
}>

export type BoardEditResult =
  | Readonly<{
      ok: true
      board: Board
      /** Minted ids, in creation order, so the caller can report them back. */
      createdCardIds: readonly NodeId[]
      createdEdgeIds: readonly EdgeId[]
      createdGroupIds: readonly NodeId[]
    }>
  | Readonly<{ ok: false; error: string }>

class EditError extends Error {}

function fail(message: string): never {
  throw new EditError(message)
}

export function applyBoardEdit(
  board: Board,
  edit: BoardEdit,
  context: BoardEditContext,
): BoardEditResult {
  try {
    let next = board
    next = applyDeletes(next, edit.delete ?? [])
    const { board: created, ids: createdCardIds } = applyCreates(
      next,
      edit.create ?? [],
      context,
    )
    next = created
    next = applyUpdates(next, edit.update ?? [])
    const { board: connected, ids: createdEdgeIds } = applyConnects(
      next,
      edit.connect ?? [],
      context,
    )
    next = connected
    const { board: grouped, ids: createdGroupIds } = applyGroups(
      next,
      edit.group ?? [],
      context,
    )
    next = grouped
    next = applyArranges(next, edit.arrange ?? [], context)
    return {
      ok: true,
      board: next,
      createdCardIds,
      createdEdgeIds,
      createdGroupIds,
    }
  } catch (error) {
    if (error instanceof EditError) return { ok: false, error: error.message }
    throw error
  }
}

function applyDeletes(board: Board, ids: readonly string[]): Board {
  let next = board
  for (const id of ids) {
    if (next.nodes.some((node) => node.id === id)) {
      // Cascades this node's edges (operations.ts's `removeNode`), which is
      // why there is no edge cleanup to ask the model to do.
      next = removeNode(next, id)
      continue
    }
    if (next.edges.some((edge) => edge.id === id)) {
      next = removeEdge(next, id)
      continue
    }
    fail(`delete: no card or connection with id "${id}".`)
  }
  return next
}

function applyCreates(
  board: Board,
  ops: readonly CreateCardOp[],
  context: BoardEditContext,
): { board: Board; ids: NodeId[] } {
  let next = board
  const ids: NodeId[] = []
  // Accumulated so a batch does not pile its own cards on one another; seeded
  // from the board so it does not pile them on existing ones either.
  const obstacles = collectObstacles(board.nodes)
  let previous: Rect | null = null

  for (const [index, op] of ops.entries()) {
    const kinds = [
      op.text !== undefined ? 'text' : null,
      op.file !== undefined ? 'file' : null,
      op.url !== undefined ? 'url' : null,
    ].filter((kind): kind is string => kind !== null)
    if (kinds.length !== 1) {
      fail(
        `create[${index}]: give exactly one of "text", "file" or "url" (got ${
          kinds.length === 0 ? 'none' : kinds.join(' and ')
        }).`,
      )
    }
    const kind = kinds[0]
    const defaultSize =
      kind === 'text' ? context.textCardSize : context.embedCardSize
    const size: Size = {
      w: positiveSize(op.w, defaultSize.w, `create[${index}].w`),
      h: positiveSize(op.h, defaultSize.h, `create[${index}].h`),
    }

    const position = resolveCreatePosition(op, size, {
      index,
      board: next,
      obstacles,
      previous,
    })

    const id = context.newNodeId(next)
    const base = {
      id,
      x: Math.round(position.x),
      y: Math.round(position.y),
      w: size.w,
      h: size.h,
      ...colorField(op.color, `create[${index}].color`),
      extra: {},
    }
    const node: BoardNode =
      kind === 'text'
        ? ({ ...base, type: 'text', text: op.text ?? '' } satisfies TextNode)
        : kind === 'file'
          ? ({
              ...base,
              type: 'file',
              file: requireNonEmpty(op.file, `create[${index}].file`),
            } satisfies FileNode)
          : ({
              ...base,
              type: 'link',
              url: requireNonEmpty(op.url, `create[${index}].url`),
            } satisfies LinkNode)

    next = addNode(next, node)
    ids.push(id)
    const rect: Rect = { x: node.x, y: node.y, w: node.w, h: node.h }
    obstacles.push(rect)
    previous = rect
  }
  return { board: next, ids }
}

function resolveCreatePosition(
  op: CreateCardOp,
  size: Size,
  scope: {
    index: number
    board: Board
    obstacles: readonly Rect[]
    previous: Rect | null
  },
): Point {
  // Explicit coordinates win outright — no search, no nudging. A model that
  // read the summary knows where things are, and second-guessing the number
  // it gave would make the coordinates it reads back untrustworthy.
  if (op.x !== undefined && op.y !== undefined) return { x: op.x, y: op.y }
  if (op.x !== undefined || op.y !== undefined) {
    fail(`create[${scope.index}]: give both "x" and "y", or neither.`)
  }

  let anchor: Rect | null = scope.previous
  if (op.anchor !== undefined) {
    const target = scope.board.nodes.find((node) => node.id === op.anchor)
    if (!target) {
      fail(
        `create[${scope.index}]: no card with id "${op.anchor}" to anchor to.`,
      )
    }
    anchor = { x: target.x, y: target.y, w: target.w, h: target.h }
  }
  return placeCard(scope.obstacles, size, {
    anchor,
    direction: op.direction,
  })
}

function applyUpdates(board: Board, ops: readonly UpdateOp[]): Board {
  let next = board
  for (const [index, op] of ops.entries()) {
    const where = `update[${index}]`
    const node = next.nodes.find((candidate) => candidate.id === op.id)
    if (node) {
      next = updateNode(next, op.id, {
        ...geometryPatch(op, where),
        ...colorField(op.color, `${where}.color`),
        ...textPatch(node, op, where),
      })
      continue
    }
    if (next.edges.some((edge) => edge.id === op.id)) {
      if (op.text !== undefined) {
        fail(`${where}: a connection has no text; use "label".`)
      }
      if (hasGeometry(op)) {
        fail(`${where}: a connection has no position or size.`)
      }
      next = updateEdge(next, op.id, {
        ...(op.label !== undefined ? { label: op.label } : {}),
        ...colorField(op.color, `${where}.color`),
      })
      continue
    }
    fail(`${where}: no card or connection with id "${op.id}".`)
  }
  return next
}

/**
 * Which of `text` / `label` this node actually has. Silently accepting the
 * wrong one would make the edit report success while changing nothing, which
 * is the failure a model cannot detect from its own transcript.
 */
function textPatch(
  node: BoardNode,
  op: UpdateOp,
  where: string,
): { text?: string; label?: string } {
  if (op.text !== undefined && node.type !== 'text') {
    fail(
      `${where}: only a text card has editable text; "${op.id}" is a ${node.type} card.`,
    )
  }
  if (op.label !== undefined && node.type !== 'group') {
    fail(
      `${where}: only a group has a label; use "text" for a text card ("${op.id}" is a ${node.type} card).`,
    )
  }
  return {
    ...(op.text !== undefined ? { text: op.text } : {}),
    ...(op.label !== undefined ? { label: op.label } : {}),
  }
}

function hasGeometry(op: UpdateOp): boolean {
  return (
    op.x !== undefined ||
    op.y !== undefined ||
    op.w !== undefined ||
    op.h !== undefined
  )
}

function geometryPatch(
  op: UpdateOp,
  where: string,
): { x?: number; y?: number; w?: number; h?: number } {
  return {
    ...(op.x !== undefined ? { x: Math.round(op.x) } : {}),
    ...(op.y !== undefined ? { y: Math.round(op.y) } : {}),
    ...(op.w !== undefined ? { w: positiveSize(op.w, 0, `${where}.w`) } : {}),
    ...(op.h !== undefined ? { h: positiveSize(op.h, 0, `${where}.h`) } : {}),
  }
}

function applyConnects(
  board: Board,
  ops: readonly ConnectOp[],
  context: BoardEditContext,
): { board: Board; ids: EdgeId[] } {
  let next = board
  const ids: EdgeId[] = []
  for (const [index, op] of ops.entries()) {
    const where = `connect[${index}]`
    requireNode(next, op.from, `${where}.from`)
    requireNode(next, op.to, `${where}.to`)
    if (op.from === op.to) fail(`${where}: a card cannot connect to itself.`)
    const id = context.newEdgeId(next)
    next = addEdge(next, {
      id,
      fromNode: op.from,
      toNode: op.to,
      // JSON Canvas's own defaults, and the ones the canvas draws by hand: a
      // connection points at its target.
      fromEnd: 'none',
      toEnd: 'arrow',
      ...(op.fromSide !== undefined
        ? { fromSide: requireSide(op.fromSide, `${where}.fromSide`) }
        : {}),
      ...(op.toSide !== undefined
        ? { toSide: requireSide(op.toSide, `${where}.toSide`) }
        : {}),
      ...(op.label !== undefined ? { label: op.label } : {}),
      ...colorField(op.color, `${where}.color`),
      extra: {},
    })
    ids.push(id)
  }
  return { board: next, ids }
}

function applyGroups(
  board: Board,
  ops: readonly GroupOp[],
  context: BoardEditContext,
): { board: Board; ids: NodeId[] } {
  let next = board
  const ids: NodeId[] = []
  for (const [index, op] of ops.entries()) {
    const where = `group[${index}]`
    if (op.ids.length === 0) fail(`${where}: give at least one card to group.`)
    const members = op.ids.map((id) => requireNode(next, id, `${where}.ids`))
    const rect = groupRectForNodes(members)
    if (!rect) fail(`${where}: give at least one card to group.`)
    const group: GroupNode = {
      id: context.newNodeId(next),
      type: 'group',
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.w),
      h: Math.round(rect.h),
      ...(op.label !== undefined ? { label: op.label } : {}),
      extra: {},
    }
    // Prepended rather than appended: a group is a frame drawn *behind* its
    // members, and paint order is node order.
    next = { ...next, nodes: [group, ...next.nodes] }
    ids.push(group.id)
  }
  return { board: next, ids }
}

function applyArranges(
  board: Board,
  ops: readonly ArrangeOp[],
  context: BoardEditContext,
): Board {
  let next = board
  for (const [index, op] of ops.entries()) {
    const where = `arrange[${index}]`
    if (op.ids.length < 2) {
      fail(`${where}: give at least two cards to arrange.`)
    }
    const rects: ArrangeRect[] = op.ids.map((id) => {
      const node = requireNode(next, id, `${where}.ids`)
      return { id: node.id, x: node.x, y: node.y, w: node.w, h: node.h }
    })
    const positions =
      op.action === 'tidy'
        ? tidyRects(rects, context.gridStep)
        : (ALIGN_EDGES as readonly string[]).includes(op.action)
          ? alignRects(rects, op.action as AlignEdge)
          : (DISTRIBUTE_AXES as readonly string[]).includes(op.action)
            ? distributeRects(rects, op.action as DistributeAxis)
            : fail(
                `${where}: unknown action "${op.action}"; expected one of ${ARRANGE_ACTIONS.join(', ')}.`,
              )
    next = setNodePositions(next, positions)
  }
  return next
}

function requireNode(board: Board, id: NodeId, where: string): BoardNode {
  const node = board.nodes.find((candidate) => candidate.id === id)
  if (!node) fail(`${where}: no card with id "${id}".`)
  return node
}

function requireSide(value: string, where: string): NodeSide {
  if (!isNodeSide(value)) {
    fail(`${where}: expected one of top, right, bottom, left (got "${value}").`)
  }
  return value
}

function requireNonEmpty(value: string | undefined, where: string): string {
  if (value === undefined || value.trim() === '') {
    fail(`${where}: must not be empty.`)
  }
  return value
}

function positiveSize(
  value: number | undefined,
  fallback: number,
  where: string,
): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) {
    fail(`${where}: must be a positive number (got ${value}).`)
  }
  return Math.round(value)
}

/**
 * A colour the model spelled, as the file stores it. An unrecognized value is
 * rejected rather than written through: the file format tolerates it
 * (fileFormat.ts keeps `color` unconstrained so unknown values round-trip),
 * but the renderer would show nothing, so accepting "light blue" would report
 * a success the board does not reflect.
 */
function colorField(
  color: string | undefined,
  where: string,
): { color?: NodeColor } {
  if (color === undefined) return {}
  const named = COLOR_NAMES[color.trim().toLowerCase()]
  if (named) return { color: named }
  if (resolveColor(color).kind === 'none') {
    fail(
      `${where}: expected one of ${COLOR_NAME_LIST.join(', ')} or a hex colour like #7852ee (got "${color}").`,
    )
  }
  return { color }
}
