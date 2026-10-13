// How a board names a node behind a portal: the portal's id, then the id of
// each portal passed through on the way in, then the node's own id —
// `portal/inner/card` (ui/canvas/portals.ts). On the board this is the node's
// id, so a card seen through a portal is selected, dragged, edited and
// connected the way any card is. In the file, an edge's end keeps the first
// id as its node and the rest as `fromPath` / `toPath` (domain/fileFormat.ts),
// so a reader that does not know about portals sees the edge reach the
// portal's card.

import { NODE_PATH_SEPARATOR, type NodeId } from './fileFormat'

/** The ids a path is made of, outermost first. */
export function splitNodePath(id: NodeId): readonly NodeId[] {
  return id.split(NODE_PATH_SEPARATOR)
}

/** The path to `ids`, outermost first. */
export function joinNodePath(ids: readonly NodeId[]): NodeId {
  return ids.join(NODE_PATH_SEPARATOR)
}

/** The id behind a portal `portal` gives `inner`. */
export function behindPortal(portal: NodeId, inner: NodeId): NodeId {
  return `${portal}${NODE_PATH_SEPARATOR}${inner}`
}
