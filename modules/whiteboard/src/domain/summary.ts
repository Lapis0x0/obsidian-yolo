// What a board looks like to a model — the text `fs_read` returns for a
// `.yoloboard` and the text an @mention injects, in place of the file itself
// (docs/plans/09-03-whiteboard-agent-tools/master.md D3, Q12).
//
// The raw file is a JSON Canvas superset: `extra` bags, `fromEnd`/`toEnd`,
// `version`, `camera`, and one object per node. A 300-card board is hundreds
// of KB of that, almost all of it machine state the model must not touch. So
// this is not a pretty-printer — it is a *reduction*, and what it keeps is
// exactly what the two things a model does with a board need:
//
//   - understanding it: what each card says, what points at what, what is
//     grouped with what;
//   - editing it: the ids `edit_board` addresses, and the coordinates that
//     make "put this to the right of that" expressible.
//
// Coordinates are given rather than hidden. They are the only real spatial
// information a board has — a serialization in reading order would be a
// lossy re-encoding of the same thing — and `edit_board` already accepts
// coordinates on the way in, so withholding them on the way out would leave
// the model able to write something it cannot read back.
//
// **Every card is previewed, none is given in full.** Reading a board is
// reading its shape; reading a card is reading its text, and that is a
// separate request (`readBoardCard`, reached as `board.yoloboard#c-8f3a`).
// The alternative — text cards verbatim because their content has no other
// exit, file cards clipped because `fs_read` can reach theirs — makes the
// cost of reading a board scale with everything ever written on it, and
// leaves the model unable to tell whether what it is holding is the whole
// card. One rule, stated in the output, is worth more than a rule that is
// cleverer per card.
//
// Zero DOM, zero host, zero I/O (Module Boundaries): a file card's preview
// lives in another vault file, so the caller resolves those and passes them
// in. `host/boardSummary.ts` is what does that reading.

import type { Board, BoardNode, NodeId } from './fileFormat'
import { nodesInsideGroup } from './groups'
import { fileNodeKind } from './naming'

/** How much of any card is shown in a board summary. */
export const CARD_PREVIEW_CHARS = 50

export type FilePreviews = ReadonlyMap<string, string>

export type BoardSummaryOptions = Readonly<{
  /** Vault path of the board, used for the heading. */
  path: string
  /** Backing-file path -> that file's leading text. Missing = no preview. */
  previews?: FilePreviews
}>

export function summarizeBoard(
  board: Board,
  { path, previews = new Map() }: BoardSummaryOptions,
): string {
  const groups = board.nodes.filter((node) => node.type === 'group')
  const cards = board.nodes.filter((node) => node.type !== 'group')

  const lines: string[] = [
    `board: ${path}`,
    countLine(cards.length, groups.length, board.edges.length),
    `card text below is the first ${CARD_PREVIEW_CHARS} characters; read one in full with "${path}#<card id>"`,
  ]

  if (groups.length > 0) {
    lines.push('', 'groups')
    for (const group of groups) {
      const members = nodesInsideGroup(group, cards)
      const label =
        group.type === 'group' && group.label ? ` "${group.label}"` : ''
      lines.push(
        `  ${group.id}${label} at ${position(group)}${
          members.length > 0 ? ` — ${members.join(' ')}` : ' — (empty)'
        }`,
      )
    }
  }

  if (cards.length > 0) {
    lines.push('', 'cards (id, kind, x,y, w×h)')
    for (const card of cards) {
      lines.push(`  ${cardHeadline(card)}`)
      const body = cardPreview(card, previews)
      if (body) lines.push(`    ${body}`)
    }
  }

  if (board.edges.length > 0) {
    lines.push('', 'edges')
    for (const edge of board.edges) {
      const label = edge.label ? ` "${edge.label}"` : ''
      lines.push(`  ${edge.id}: ${edge.fromNode} -> ${edge.toNode}${label}`)
    }
  }

  return lines.join('\n')
}

/**
 * One card, in full — what `board.yoloboard#c-8f3a` resolves to.
 *
 * Only a text card actually has text of its own to give back. Every other
 * kind is a pointer, and its target is already named in the summary, so this
 * says where to go rather than pretending to have the content: a file card's
 * text is in that vault file, which `fs_read` reads directly.
 *
 * Null means no such card, which the caller reports as a failed read rather
 * than as an empty one.
 */
export function readBoardCard(board: Board, cardId: NodeId): string | null {
  const card = board.nodes.find((node) => node.id === cardId)
  if (!card) return null
  switch (card.type) {
    case 'text':
      return card.text
    case 'file':
      return `This card embeds ${card.file} — read that file for its content.`
    case 'link':
      return `This card embeds the web page ${card.url}.`
    case 'group': {
      const members = nodesInsideGroup(
        card,
        board.nodes.filter((node) => node.type !== 'group'),
      )
      const label = card.label ? ` "${card.label}"` : ''
      return `Group${label} containing ${members.length} card(s): ${members.join(' ')}`
    }
  }
}

function countLine(cards: number, groups: number, edges: number): string {
  const parts = [plural(cards, 'card'), plural(edges, 'edge')]
  if (groups > 0) parts.push(plural(groups, 'group'))
  return parts.join(', ')
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function position(node: BoardNode): string {
  return `${node.x},${node.y} ${node.w}×${node.h}`
}

/**
 * The kind a model should reason about, which is finer than the file format's
 * four node types: a `file` node is a note, an image, or a media file
 * depending on its extension, and those behave differently enough (a note has
 * text to read and edit; an image does not) that flattening them to "file"
 * would hide the distinction that matters.
 */
function cardKind(card: BoardNode): string {
  switch (card.type) {
    case 'text':
      return 'text'
    case 'link':
      return 'web'
    case 'file':
      switch (fileNodeKind(card.file)) {
        case 'markdown':
          return 'note'
        case 'image':
          return 'image'
        case 'audio':
          return 'audio'
        case 'video':
          return 'video'
        case 'html':
          return 'page'
        default:
          return 'file'
      }
    case 'group':
      return 'group'
  }
}

function cardHeadline(card: BoardNode): string {
  const head = `${card.id}  ${cardKind(card)}  ${position(card)}`
  switch (card.type) {
    case 'file':
      return `${head}  ${card.file}`
    case 'link':
      return `${head}  ${card.url}`
    default:
      return head
  }
}

function cardPreview(card: BoardNode, previews: FilePreviews): string | null {
  if (card.type === 'text') {
    const text = card.text.trim()
    return text ? clip(text) : '(empty)'
  }
  if (card.type === 'file' && fileNodeKind(card.file) === 'markdown') {
    const preview = previews.get(card.file)?.trim()
    // Distinguishes "the note is empty" from "nobody resolved this one" —
    // the second is a fact about this summary, not about the vault, and a
    // model that cannot tell them apart will not know that `fs_read` would
    // help.
    if (preview === undefined) return null
    return preview ? clip(preview) : '(empty note)'
  }
  return null
}

function clip(text: string): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (flattened.length <= CARD_PREVIEW_CHARS) return flattened
  return `${flattened.slice(0, CARD_PREVIEW_CHARS)}…`
}

/** Backing-file paths whose text a full summary wants, in board order. */
export function previewablePaths(board: Board): string[] {
  const seen = new Set<string>()
  for (const node of board.nodes) {
    if (node.type !== 'file') continue
    if (fileNodeKind(node.file) !== 'markdown') continue
    seen.add(node.file)
  }
  return [...seen]
}
