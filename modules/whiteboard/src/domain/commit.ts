// Pure decision logic for "what does committing a card's live-edited text
// actually do", factored out of the DOM-heavy canvas UI so the blur/Escape/
// dispose commit paths (src/ui/canvas.ts) all route through one testable
// choke point rather than each re-deriving "file node -> write the file,
// text node -> updateNode" independently (docs/plans/08-25-yolo-whiteboard/
// p1-design.md §1.2, §3: "Escape/blur 共用同一提交路径，不双写").
//
// A node with no editable text — a group, a link, or a file node pointing at
// something that isn't markdown — is a no-op rather than a reachable case:
// callers should not be invoking this for one, but a defensive no-op is safer
// than an exception on a future data/UI desync.

import type { Board, NodeId } from './fileFormat'
import { isMarkdownPath } from './naming'
import { updateNode } from './operations'

export type NodeCommitAction =
  | Readonly<{ kind: 'writeNoteFile'; file: string; markdown: string }>
  | Readonly<{ kind: 'updateBoard'; board: Board }>
  | Readonly<{ kind: 'noop' }>

/**
 * `board` must be the board the node currently lives in; `markdown` is the
 * live text read from the card's editor at commit time. Returns what to do
 * with it — the caller performs the actual I/O (vault write / requestSave).
 */
export function planNodeCommit(
  board: Board,
  nodeId: NodeId,
  markdown: string,
): NodeCommitAction {
  const node = board.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return { kind: 'noop' }
  switch (node.type) {
    case 'file':
      return isMarkdownPath(node.file)
        ? { kind: 'writeNoteFile', file: node.file, markdown }
        : { kind: 'noop' }
    case 'text':
      return {
        kind: 'updateBoard',
        board: updateNode(board, nodeId, { text: markdown }),
      }
    case 'link':
    case 'group':
      return { kind: 'noop' }
  }
}
