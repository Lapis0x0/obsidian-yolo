// A PDF card spread out as pages (fileFormat.ts's `PdfSpread`) — how the one
// node a file holds becomes the several things the board moves, and back.
//
// The file keeps a PDF as one node: its rectangle is the reader card's, and
// an open spread is a field on it. The board cannot work with that. Every
// piece of it that reasons about space — virtualization, hit-testing, snapping,
// group membership, edges, placement, tidying — asks a node for one rectangle,
// and a spread is a title plus a sheet per page, each placed on its own.
//
// So the board is given a different, equivalent shape (`expandBoard`): while a
// spread is open its node *is its title* — same id, the title's rectangle —
// and every page is a `pdf-page` node of its own. Whatever the board already
// does for a card it now does for a sheet, and what it does for the node it
// does for the document as a whole: a group holds the PDF when it holds the
// title, an edge to the node reaches the whole PDF, deleting the node deletes
// all of it. The few rules that are about the document rather than a rectangle
// — a sheet moves with its title, a sheet alone cannot be deleted — are the
// helpers at the bottom of this file.
//
// `collapseBoard` is the inverse, and is what is written. Both are total and
// pure, and `collapseBoard(expandBoard(b))` is `b`.
//
// Zero dependencies beyond the file format (Module Boundaries, CLAUDE.md).

import type {
  Board,
  BoardNode,
  Edge,
  FileNode,
  NodeId,
  PdfPageNode,
  PdfSpread,
  SpreadRect,
} from './fileFormat'

/**
 * How a spread is first laid out, in world units — whole cells of the board's
 * 13-unit grid (ui/constants.ts's GRID_WORLD_STEP_PX), so a laid-out spread
 * sits on the lattice a dragged card snaps to.
 *
 * A page is as wide as a new PDF card (NEW_EMBED_CARD_SIZE), so a spread
 * reads at the size the card it came from did.
 */
export type SpreadMetrics = Readonly<{
  pageWidth: number
  gap: number
  titleHeight: number
  titleGap: number
}>

export const SPREAD_METRICS: SpreadMetrics = Object.freeze({
  pageWidth: 390,
  /** Between two sheets, across and down: enough to read them as separate
   * pieces of paper rather than one long page. */
  gap: 26,
  /** The title's height; its width follows its text (`titleWidthFor`). */
  titleHeight: 39,
  /** Between the title and the first row of sheets. */
  titleGap: 13,
})

/** A page's own proportions — its width and height in any one unit. */
export type PageSize = Readonly<{ width: number; height: number }>

export type SpreadLayout = Readonly<{
  title: SpreadRect
  pages: readonly SpreadRect[]
}>

/** The id a spread's page has on the board: derived from its PDF's, so it is
 * the same every time the board is read. `/` never appears in a minted id
 * (domain/ids.ts), so it cannot be taken by a node of the file's own. */
export function pdfPageNodeId(parent: NodeId, page: number): NodeId {
  return `${parent}/p${page}`
}

/** Whether a node is the title of an open spread — a PDF node standing for
 * its pages while they are out. */
export function isSpreadTitle(
  node: BoardNode | undefined,
): node is FileNode & Readonly<{ readerRect: SpreadRect }> {
  return node?.type === 'file' && node.readerRect !== undefined
}

// ---------------------------------------------------------------------------
// File <-> board
// ---------------------------------------------------------------------------

/**
 * The board's shape of a board read from a file: every open spread opened
 * (`openSpread`). A board without one is returned as it is.
 */
export function expandBoard(board: Board): Board {
  let next = board
  for (const node of board.nodes) {
    if (node.type === 'file' && node.spread?.open === true) {
      next = openSpread(next, node.id)
    }
  }
  return next
}

/**
 * The file's shape of the board: every open spread folded back into its node,
 * marked open, with the layout its title and sheets have now. Sheets whose PDF
 * is gone or no longer spread out are dropped, with their edges — there is
 * nothing in the file they could be written as.
 */
export function collapseBoard(board: Board): Board {
  let next = board
  for (const node of board.nodes) {
    if (isSpreadTitle(node)) next = foldSpread(next, node.id, true)
  }
  return dropOrphanPages(next)
}

// ---------------------------------------------------------------------------
// Opening and putting away
// ---------------------------------------------------------------------------

/**
 * Brings a PDF node's pages out: the node becomes its title, and a sheet per
 * page joins the board just after it (paint order is board order, so the
 * sheets sit above whatever the node sat above). Edges that name one of its
 * pages move onto that sheet.
 *
 * `layout` is used when given — a first spread, or one laid out afresh —
 * and otherwise the one the node remembers. A node that is already open, is
 * not a file node, or has no layout to use is returned unchanged.
 */
export function openSpread(
  board: Board,
  id: NodeId,
  layout?: SpreadLayout,
): Board {
  const index = board.nodes.findIndex((node) => node.id === id)
  if (index === -1) return board
  const node = board.nodes[index]
  if (node.type !== 'file' || isSpreadTitle(node)) return board
  const use = layout ?? node.spread
  if (!use || use.pages.length === 0) return board

  const { spread: _spread, ...rest } = node
  const title: FileNode = {
    ...rest,
    x: use.title.x,
    y: use.title.y,
    w: use.title.w,
    h: use.title.h,
    readerRect: { x: node.x, y: node.y, w: node.w, h: node.h },
  }
  const pages: PdfPageNode[] = use.pages.map((rect, pageIndex) => ({
    id: pdfPageNodeId(id, pageIndex + 1),
    type: 'pdf-page',
    parent: id,
    file: node.file,
    page: pageIndex + 1,
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    extra: {},
  }))
  const nodes = [
    ...board.nodes.slice(0, index),
    title,
    ...pages,
    ...board.nodes.slice(index + 1),
  ]

  const pageCount = pages.length
  const onSheet = (nodeId: NodeId, page: number | undefined) =>
    nodeId === id && page !== undefined && page <= pageCount
  let edgesChanged = false
  const edges = board.edges.map((edge) => {
    const from = onSheet(edge.fromNode, edge.fromPage)
    const to = onSheet(edge.toNode, edge.toPage)
    if (!from && !to) return edge
    edgesChanged = true
    const { fromPage, toPage, ...base } = edge
    return {
      ...base,
      ...(from
        ? { fromNode: pdfPageNodeId(id, fromPage as number) }
        : fromPage === undefined
          ? {}
          : { fromPage }),
      ...(to
        ? { toNode: pdfPageNodeId(id, toPage as number) }
        : toPage === undefined
          ? {}
          : { toPage }),
    } satisfies Edge
  })
  return { ...board, nodes, edges: edgesChanged ? edges : board.edges }
}

/**
 * Puts a spread's pages away: the node is a reader card again, where it was
 * before, and remembers where its title and every sheet were for the next
 * time. Edges on a sheet stay attached to that page, and reach the card
 * until the pages are out again.
 */
export function closeSpread(board: Board, id: NodeId): Board {
  if (!isSpreadTitle(board.nodes.find((node) => node.id === id))) return board
  return dropOrphanPages(foldSpread(board, id, false))
}

/**
 * `closeSpread`'s fold, for the file (`open`: the spread was out when it was
 * written) or for good. Sheets are left in place; `dropOrphanPages` takes
 * them off once nothing is spread out behind them.
 */
function foldSpread(board: Board, id: NodeId, open: boolean): Board {
  const index = board.nodes.findIndex((node) => node.id === id)
  const node = board.nodes[index]
  if (!isSpreadTitle(node)) return board
  const sheets = board.nodes
    .filter(
      (candidate): candidate is PdfPageNode =>
        candidate.type === 'pdf-page' && candidate.parent === id,
    )
    .sort((a, b) => a.page - b.page)
  const { readerRect, ...rest } = node
  const spread: PdfSpread = {
    open,
    title: { x: node.x, y: node.y, w: node.w, h: node.h },
    pages: sheets.map((sheet) => ({
      x: sheet.x,
      y: sheet.y,
      w: sheet.w,
      h: sheet.h,
    })),
  }
  const folded: FileNode = {
    ...rest,
    ...readerRect,
    ...(sheets.length > 0 ? { spread } : {}),
  }
  const nodes = board.nodes.slice()
  nodes[index] = folded

  const pageOf = new Map(sheets.map((sheet) => [sheet.id, sheet.page]))
  let edgesChanged = false
  const edges = board.edges.map((edge) => {
    const fromPage = pageOf.get(edge.fromNode)
    const toPage = pageOf.get(edge.toNode)
    if (fromPage === undefined && toPage === undefined) return edge
    edgesChanged = true
    return {
      ...edge,
      ...(fromPage === undefined ? {} : { fromNode: id, fromPage }),
      ...(toPage === undefined ? {} : { toNode: id, toPage }),
    }
  })
  return { ...board, nodes, edges: edgesChanged ? edges : board.edges }
}

/** Takes off every sheet whose PDF is not spread out on this board, with the
 * edges attached to them. */
function dropOrphanPages(board: Board): Board {
  const titles = new Set(
    board.nodes.filter(isSpreadTitle).map((node) => node.id),
  )
  const orphans = new Set(
    board.nodes
      .filter((node) => node.type === 'pdf-page' && !titles.has(node.parent))
      .map((node) => node.id),
  )
  if (orphans.size === 0) return board
  return {
    ...board,
    nodes: board.nodes.filter((node) => !orphans.has(node.id)),
    edges: board.edges.filter(
      (edge) => !orphans.has(edge.fromNode) && !orphans.has(edge.toNode),
    ),
  }
}

// ---------------------------------------------------------------------------
// The document as a whole
// ---------------------------------------------------------------------------

/** The sheets of an open spread, in page order. */
export function spreadPages(
  board: Board,
  titleId: NodeId,
): readonly PdfPageNode[] {
  return board.nodes
    .filter(
      (node): node is PdfPageNode =>
        node.type === 'pdf-page' && node.parent === titleId,
    )
    .sort((a, b) => a.page - b.page)
}

/**
 * The nodes that go when `ids` are deleted: a spread's title takes every one
 * of its sheets with it, and a sheet on its own goes nowhere — a page is part
 * of its PDF, and is removed only with the whole of it.
 */
export function nodesToDelete(
  nodes: readonly BoardNode[],
  ids: Iterable<NodeId>,
): NodeId[] {
  const asked = new Set(ids)
  const out: NodeId[] = []
  for (const node of nodes) {
    if (node.type === 'pdf-page') {
      if (asked.has(node.parent)) out.push(node.id)
      continue
    }
    if (asked.has(node.id)) out.push(node.id)
  }
  return out
}

/**
 * Adds to `ids` the sheets of every spread title among them: moving a title
 * moves the document, each sheet keeping its place relative to the others.
 */
export function withSpreadPages(
  nodes: readonly BoardNode[],
  ids: ReadonlySet<NodeId>,
): Set<NodeId> {
  const out = new Set(ids)
  for (const node of nodes) {
    if (node.type === 'pdf-page' && ids.has(node.parent)) out.add(node.id)
  }
  return out
}

// ---------------------------------------------------------------------------
// Laying a spread out
// ---------------------------------------------------------------------------

/**
 * How many sheets across a first spread puts in a row: about as many as it
 * takes for the whole spread to come out square, which is the shape that
 * shows most of a document at once on a screen. Fifteen letter pages come
 * out five across, three down.
 */
export function defaultSpreadColumns(
  pages: readonly PageSize[],
  metrics = SPREAD_METRICS,
): number {
  const count = pages.length
  if (count <= 1) return 1
  const heights = pages.map((page) => sheetHeight(page, metrics.pageWidth))
  const averageHeight = heights.reduce((sum, h) => sum + h, 0) / count
  const cellW = metrics.pageWidth + metrics.gap
  const cellH = averageHeight + metrics.gap
  // cols * cellW = rows * cellH with rows = count / cols.
  const columns = Math.round(Math.sqrt((count * cellH) / cellW))
  return Math.min(count, Math.max(1, columns))
}

/** How many sheets across fit in `width`: whole columns only, at least one. */
export function spreadColumnsForWidth(
  width: number,
  metrics = SPREAD_METRICS,
): number {
  return Math.max(
    1,
    Math.floor((width + metrics.gap) / (metrics.pageWidth + metrics.gap)),
  )
}

/** The width `columns` sheets take across, gaps included. */
export function spreadWidthForColumns(
  columns: number,
  metrics = SPREAD_METRICS,
): number {
  return columns * metrics.pageWidth + (columns - 1) * metrics.gap
}

/**
 * Lays a spread out as a grid under its title: `columns` sheets to a row,
 * each row as tall as its tallest sheet, the title's top-left at `origin`.
 * Every sheet is `pageWidth` wide and as tall as its page's proportions make
 * it.
 */
export function layoutSpreadGrid(
  pages: readonly PageSize[],
  origin: Readonly<{ x: number; y: number }>,
  columns: number,
  titleWidth: number,
  metrics = SPREAD_METRICS,
): SpreadLayout {
  const perRow = Math.max(1, Math.min(columns, pages.length))
  const title: SpreadRect = {
    x: origin.x,
    y: origin.y,
    w: titleWidth,
    h: metrics.titleHeight,
  }
  const rects: SpreadRect[] = []
  let rowTop = origin.y + metrics.titleHeight + metrics.titleGap
  for (let start = 0; start < pages.length; start += perRow) {
    const row = pages.slice(start, start + perRow)
    let rowHeight = 0
    row.forEach((page, column) => {
      const h = sheetHeight(page, metrics.pageWidth)
      rowHeight = Math.max(rowHeight, h)
      rects.push({
        x: origin.x + column * (metrics.pageWidth + metrics.gap),
        y: rowTop,
        w: metrics.pageWidth,
        h,
      })
    })
    rowTop += rowHeight + metrics.gap
  }
  return { title, pages: rects }
}

/**
 * Lays an open spread's sheets out afresh at `columns` across, under its title
 * where it stands — the pages keep their sizes and take new places. What the
 * spread's resize handle does, and why it takes back every sheet, including
 * ones moved away on their own: the grid is a way of arranging the whole
 * document, not a place some sheets belong to.
 */
export function reflowSpread(
  board: Board,
  titleId: NodeId,
  columns: number,
  metrics = SPREAD_METRICS,
): Board {
  const title = board.nodes.find((node) => node.id === titleId)
  if (!isSpreadTitle(title)) return board
  const sheets = spreadPages(board, titleId)
  if (sheets.length === 0) return board
  const layout = layoutSpreadGrid(
    sheets.map((sheet) => ({ width: sheet.w, height: sheet.h })),
    { x: title.x, y: title.y },
    columns,
    title.w,
    { ...metrics, pageWidth: sheets[0].w },
  )
  const rectById = new Map(
    sheets.map((sheet, index) => [sheet.id, layout.pages[index]]),
  )
  let changed = false
  const nodes = board.nodes.map((node) => {
    const rect = rectById.get(node.id)
    if (!rect || (rect.x === node.x && rect.y === node.y)) return node
    changed = true
    return { ...node, x: rect.x, y: rect.y }
  })
  return changed ? { ...board, nodes } : board
}

/** How many columns an open spread's sheets are in right now, read off the
 * first row — what the resize handle starts from. */
export function currentSpreadColumns(
  sheets: readonly PdfPageNode[],
  metrics = SPREAD_METRICS,
): number {
  if (sheets.length === 0) return 1
  const top = sheets[0].y
  let count = 0
  for (const sheet of sheets) {
    if (Math.abs(sheet.y - top) > metrics.gap) break
    count += 1
  }
  return Math.max(1, count)
}

/**
 * A title's width for its text, before it has been measured: a generous
 * estimate the renderer corrects once it has laid the text out.
 */
export function titleWidthFor(name: string, metrics = SPREAD_METRICS): number {
  const charWidth = 11
  const padding = 16
  return Math.max(
    metrics.titleHeight * 2,
    Math.round(name.length * charWidth + padding),
  )
}

function sheetHeight(page: PageSize, width: number): number {
  if (!(page.width > 0) || !(page.height > 0)) return Math.round(width * 1.294)
  return Math.round((width * page.height) / page.width)
}
