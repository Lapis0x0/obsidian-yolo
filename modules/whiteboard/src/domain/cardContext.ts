// What one card knows about where it lives — the text handed to a model that
// is about to write, or answer a question about, a single card
// (docs/plans/09-07-whiteboard-card-ai/master.md §4).
//
// Three parts, and the split is the whole design:
//
//   1. **The board, summarized** — `summarizeBoard`, unchanged: every card's
//      id, kind, coordinates and 50-character preview, plus groups and edges.
//      It is a map, not a reading: what it tells the model is which cards
//      exist and which one to reach for next.
//   2. **This card**, by id and position, because everything the model does
//      is relative to it.
//   3. **Its sources, in full** — a card wired *into* this one is the one
//      thing the user has already said belongs here, so it is the one thing
//      given without being asked for. A 50-character preview of the card
//      someone just dragged an arrow from is a preview of the whole task.
//
// Everything else stays a preview and is read on demand (`read_card`). That
// is what keeps the cost of this text bounded by the board's *shape* rather
// than by everything ever written on it — the same rule `summarizeBoard`
// states in its own output.
//
// Pure and I/O-free (Module Boundaries): a note card's text lives in another
// vault file, so the caller reads those and passes them in — `host/
// cardContext.ts` is what does that reading. Keeping the assembly pure is
// also what lets a caller that already holds the texts (a synchronous
// `getContext`) build the same string without awaiting anything.

import type { Board, BoardNode, NodeId } from './fileFormat'
import { nodesInsideGroup } from './groups'
import { fileNodeKind } from './naming'
import { summarizeBoard } from './summary'

/** Backing-file path -> that file's text. */
export type CardContextNoteTexts = ReadonlyMap<string, string>

export type CardContextOptions = Readonly<{
  board: Board
  /** The card the context is being built for. */
  nodeId: NodeId
  /** Vault path of the board, for the summary's heading. */
  path: string
  /**
   * Text for the note cards on the board. A source card needs the whole
   * file; every other card is only ever previewed, so a clipped copy is
   * enough. Missing entries are reported as unread rather than as empty.
   */
  noteTexts?: CardContextNoteTexts
}>

/**
 * Ids of the cards wired *into* `nodeId` — the sources whose text is given in
 * full. Incoming edges only: an arrow drawn from A to B says B is about A,
 * and the reverse direction is a card this one feeds, not one it comes from.
 */
export function cardSourceIds(board: Board, nodeId: NodeId): NodeId[] {
  const ids: NodeId[] = []
  for (const edge of board.edges) {
    if (edge.toNode !== nodeId) continue
    if (edge.fromNode === nodeId) continue
    if (ids.includes(edge.fromNode)) continue
    ids.push(edge.fromNode)
  }
  return ids
}

/**
 * Vault paths whose *whole* text this card's context needs: every note card
 * that is a source, plus every note card inside a source group.
 *
 * A group stores no member list — membership is geometry (`nodesInsideGroup`)
 * — so it is resolved here rather than read off the node.
 */
export function cardSourceNotePaths(board: Board, nodeId: NodeId): string[] {
  const paths: string[] = []
  for (const node of expandedSources(board, nodeId)) {
    if (node.type !== 'file') continue
    if (fileNodeKind(node.file) !== 'markdown') continue
    if (!paths.includes(node.file)) paths.push(node.file)
  }
  return paths
}

export function buildCardContext({
  board,
  nodeId,
  path,
  noteTexts = new Map(),
}: CardContextOptions): string {
  const sections = [
    summarizeBoard(board, { path, previews: noteTexts }),
    thisCardSection(board, nodeId),
  ]
  const sources = sourcesSection(board, nodeId, noteTexts)
  if (sources) sections.push(sources)
  return sections.join('\n\n')
}

// ---- sections ------------------------------------------------------------

function thisCardSection(board: Board, nodeId: NodeId): string {
  const card = board.nodes.find((node) => node.id === nodeId)
  if (!card) return `this card: ${nodeId} (no longer on the board)`
  return [
    `this card: ${nodeId} at ${card.x},${card.y} ${card.w}×${card.h}`,
    "Everything you write is this card's content, and nothing else on the board changes.",
  ].join('\n')
}

function sourcesSection(
  board: Board,
  nodeId: NodeId,
  noteTexts: CardContextNoteTexts,
): string | null {
  const sources = cardSourceIds(board, nodeId)
    .map((id) => board.nodes.find((node) => node.id === id))
    .filter((node): node is BoardNode => node !== undefined)
  if (sources.length === 0) return null

  const lines = [
    'sources — the cards connected into this one, in full. This is what this card is about.',
  ]
  for (const source of sources) {
    if (source.type !== 'group') {
      lines.push('', ...cardBlock(source, noteTexts))
      continue
    }
    const members = groupMembers(board, source)
    const label = source.label ? ` "${source.label}"` : ''
    lines.push(
      '',
      `--- ${source.id}${label} — a group of ${members.length} card(s), all of it below ---`,
    )
    for (const member of members)
      lines.push('', ...cardBlock(member, noteTexts))
  }
  return lines.join('\n')
}

function cardBlock(card: BoardNode, noteTexts: CardContextNoteTexts): string[] {
  return [`--- ${card.id} ---`, cardBody(card, noteTexts)]
}

function cardBody(card: BoardNode, noteTexts: CardContextNoteTexts): string {
  switch (card.type) {
    case 'text':
      return card.text.trim() === '' ? '(this card is empty)' : card.text
    case 'file': {
      if (fileNodeKind(card.file) !== 'markdown') {
        return `(this card holds the file ${card.file}, which has no text)`
      }
      const text = noteTexts.get(card.file)
      if (text === undefined) {
        return `(this card embeds the note ${card.file}, which could not be read)`
      }
      return text.trim() === ''
        ? `(this card embeds the note ${card.file}, which is empty)`
        : `note ${card.file}:\n${text}`
    }
    case 'link':
      return `(this card embeds the web page ${card.url})`
    case 'group':
      // A group nested in a source group: its own members are already in the
      // list, because containment is transitive (`nodesInsideGroup`).
      return `(a group${card.label ? ` "${card.label}"` : ''})`
  }
}

/** A source's cards: the source itself, or a group's members in board order. */
function expandedSources(board: Board, nodeId: NodeId): BoardNode[] {
  const expanded: BoardNode[] = []
  for (const id of cardSourceIds(board, nodeId)) {
    const source = board.nodes.find((node) => node.id === id)
    if (!source) continue
    if (source.type === 'group') expanded.push(...groupMembers(board, source))
    else expanded.push(source)
  }
  return expanded
}

function groupMembers(board: Board, group: BoardNode): BoardNode[] {
  const cards = board.nodes.filter((node) => node.type !== 'group')
  const memberIds = new Set(nodesInsideGroup(group, cards))
  return cards.filter((node) => memberIds.has(node.id))
}
