/**
 * Fades in the tail of a streamed block.
 *
 * The reveal is a pure function of (position, age): every played-out frame the
 * renderer hands over the segments still inside the fade window — one per frame
 * that added characters — each carrying its age, and this plugin wraps the
 * matching source ranges in spans phased by a negative `animation-delay` equal
 * to that age. The browser interpolates the opacity on every display frame, so
 * the fade stays smooth on high-refresh screens while the playout loop keeps
 * running at 30fps.
 *
 * The phase must come from the characters' age, not from when an element
 * mounted: react-markdown rebuilds the tree every frame and keys children by
 * ordinal, so a span that survives reconciliation is usually showing a
 * different segment than it did on the previous frame, and a CSS animation
 * left running would carry the previous segment's phase. The animation name
 * therefore alternates between two identical keyframe sets with the playout
 * frame's parity, which forces a restart and re-anchors the negative delay on
 * every wrapped span, reused or not.
 *
 * The wrapping happens in the HAST tree rather than on the rendered DOM,
 * because the streaming surface is React-managed: splitting text nodes by hand
 * afterwards would fight reconciliation on the next frame.
 *
 * One span per segment, and a segment is a frame's worth of characters, so the
 * number of wrapped nodes is the fade window divided by the frame interval — a
 * constant, independent of both the stream rate and the length of the answer.
 */

type HastNode = {
  type: string
  tagName?: string
  value?: string
  children?: HastNode[]
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
  properties?: Record<string, unknown>
}

export type RevealSegment = {
  /** Offset into the block's markdown source where this segment starts. */
  from: number
  /** How long ago this segment's characters were played out, in ms. */
  ageMs: number
}

/** Playout frame parity; selects which of the two identical animations runs. */
export type RevealPhase = 0 | 1

// Animating inside these would either be meaningless or actively wrong: code
// and math are rendered by dedicated components, and svg/annotation subtrees
// are not prose.
const SKIP_TAGS = new Set(['code', 'pre', 'svg', 'math', 'annotation'])

const REVEAL_CLASS = 'yolo-stream-reveal'

function createRevealSpan(
  value: string,
  ageMs: number,
  phase: RevealPhase,
): HastNode {
  const delayMs = Math.max(0, Math.round(ageMs))
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className: [REVEAL_CLASS],
      style: `animation-name:${REVEAL_CLASS}-${phase === 0 ? 'a' : 'b'};animation-delay:-${delayMs}ms`,
    },
    children: [{ type: 'text', value }],
  }
}

/**
 * Index of the segment covering `offset`, or -1 when it sits before the first
 * one — that text has already settled and stays unwrapped.
 */
function segmentIndexAt(segments: RevealSegment[], offset: number): number {
  for (let index = segments.length - 1; index >= 0; index--) {
    if (segments[index].from <= offset) {
      return index
    }
  }
  return -1
}

/**
 * Replaces the text nodes that extend into the fade window with one span per
 * segment. A node is only split when its `value` length matches the source span
 * it came from; when markdown escapes or character entities make the two
 * disagree, the node is revealed as a whole rather than sliced at a position
 * that does not mean what it looks like.
 */
function revealChildren(
  node: HastNode,
  segments: RevealSegment[],
  phase: RevealPhase,
  insideSkippedTag: boolean,
): void {
  const children = node.children
  if (!children || children.length === 0) {
    return
  }

  const windowStart = segments[0].from
  const next: HastNode[] = []
  let changed = false

  for (const child of children) {
    if (child.type === 'element') {
      const skip =
        insideSkippedTag ||
        (child.tagName !== undefined && SKIP_TAGS.has(child.tagName))
      revealChildren(child, segments, phase, skip)
      next.push(child)
      continue
    }

    if (insideSkippedTag || child.type !== 'text' || !child.value) {
      next.push(child)
      continue
    }

    const start = child.position?.start?.offset
    const end = child.position?.end?.offset
    if (start === undefined || end === undefined || end <= windowStart) {
      next.push(child)
      continue
    }

    const value = child.value

    if (end - start !== value.length) {
      next.push(
        createRevealSpan(
          value,
          segments[segmentIndexAt(segments, Math.max(start, windowStart))]
            .ageMs,
          phase,
        ),
      )
      changed = true
      continue
    }

    let cursor = start
    const pushPiece = (pieceEnd: number) => {
      if (pieceEnd <= cursor) {
        return
      }
      const piece = value.slice(cursor - start, pieceEnd - start)
      const index = segmentIndexAt(segments, cursor)
      next.push(
        index < 0
          ? { type: 'text', value: piece }
          : createRevealSpan(piece, segments[index].ageMs, phase),
      )
      cursor = pieceEnd
    }

    for (const segment of segments) {
      if (segment.from > start && segment.from < end) {
        pushPiece(segment.from)
      }
    }
    pushPiece(end)
    changed = true
  }

  if (changed) {
    node.children = next
  }
}

/**
 * Builds a rehype plugin that reveals the given segments. `segments` must be
 * ascending by `from`; the last one runs to the end of the block.
 */
export function createStreamingRevealPlugin(
  segments: RevealSegment[],
  phase: RevealPhase,
) {
  return function streamingRevealPlugin() {
    return (tree: HastNode): void => {
      if (segments.length === 0) {
        return
      }
      revealChildren(tree, segments, phase, false)
    }
  }
}
