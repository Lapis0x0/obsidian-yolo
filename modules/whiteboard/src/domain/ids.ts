// Card and connection ids.
//
// Short, not universally unique. An id only has to be unique *within one
// board*, and it is read and written far more often than a file-scoped id
// suggests: the board summary a model reads spells out every id, and every
// `edit_board` call spells the ones it touches back. A UUID costs 36
// characters in both directions — on a 300-card board that is ten kilobytes
// of the summary spent on nothing, and thirty-six characters a model has to
// transcribe exactly for each card it edits.
//
// So an id is four hex digits, minted against the ids the board already has
// and retried on a collision. Collisions are the normal case at this length
// (a few hundred cards in a 65,536-wide space), which is why the check is
// not a formality; the suffix simply grows if a board is ever dense enough
// that retrying stops working, so minting always terminates.
//
// `Math.random` rather than `crypto`: nothing here is a secret or a
// capability, only a label that has to differ from its neighbours, and the
// board is right there to confirm that it does. It also keeps this file free
// of a `window`, which a popout would otherwise make ambiguous.

import {
  type Board,
  type EdgeId,
  NODE_PATH_SEPARATOR,
  type NodeId,
} from './fileFormat'

const NODE_PREFIX = 'c-'
const EDGE_PREFIX = 'e-'

const SUFFIX_LENGTH = 4
const ATTEMPTS_PER_LENGTH = 8

export function mintNodeId(board: Board): NodeId {
  return mint(NODE_PREFIX, names(board.nodes))
}

export function mintEdgeId(board: Board): EdgeId {
  return mint(EDGE_PREFIX, names(board.edges))
}

/** The ids taken: each one's name in the file it is in, too — a card or
 * edge behind a portal (domain/nodePath.ts) is `portal/name` here and
 * `name` there, and a new one may end up in either file. */
function names(items: readonly Readonly<{ id: string }>[]): Set<string> {
  const taken = new Set<string>()
  for (const { id } of items) {
    taken.add(id)
    const at = id.lastIndexOf(NODE_PATH_SEPARATOR)
    if (at >= 0) taken.add(id.slice(at + 1))
  }
  return taken
}

function mint(prefix: string, taken: ReadonlySet<string>): string {
  for (let length = SUFFIX_LENGTH; ; length += 1) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_LENGTH; attempt += 1) {
      const id = `${prefix}${suffix(length)}`
      if (!taken.has(id)) return id
    }
  }
}

function suffix(length: number): string {
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out += Math.floor(Math.random() * 16).toString(16)
  }
  return out
}
