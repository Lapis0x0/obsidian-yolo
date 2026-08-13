/**
 * Fades in the characters a streamed frame just revealed.
 *
 * The wrapping happens in the HAST tree rather than on the rendered DOM,
 * because the streaming surface is React-managed: splitting text nodes by hand
 * afterwards would fight reconciliation on the next frame.
 *
 * Only the block the model is still writing into gets a plugin, and only the
 * characters after `revealFrom` are wrapped. Once a block stops being the
 * trailing one it renders without the plugin, which drops its spans — so the
 * number of animated nodes stays in the single digits instead of growing with
 * the answer.
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

// Animating inside these would either be meaningless or actively wrong: code
// and math are rendered by dedicated components, and svg/annotation subtrees
// are not prose.
const SKIP_TAGS = new Set(['code', 'pre', 'svg', 'math', 'annotation'])

const REVEAL_CLASS = 'yolo-stream-reveal'

function createRevealSpan(value: string): HastNode {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: [REVEAL_CLASS] },
    children: [{ type: 'text', value }],
  }
}

function splitIntoRevealNodes(value: string): HastNode[] {
  // Per-character so CJK animates too — it has no spaces to split on, and
  // splitting by whitespace would fade in a whole Chinese paragraph at once.
  return Array.from(value, (character) => createRevealSpan(character))
}

/**
 * Replaces the text nodes that extend past `revealFrom` with per-character
 * spans. A node is only split when its `value` length matches the source span
 * it came from; when markdown escapes or character entities make the two
 * disagree, the node is animated as a whole rather than sliced at a position
 * that does not mean what it looks like.
 */
function revealChildren(
  node: HastNode,
  revealFrom: number,
  insideSkippedTag: boolean,
): void {
  const children = node.children
  if (!children || children.length === 0) {
    return
  }

  const next: HastNode[] = []
  let changed = false

  for (const child of children) {
    if (child.type === 'element') {
      const skip =
        insideSkippedTag ||
        (child.tagName !== undefined && SKIP_TAGS.has(child.tagName))
      revealChildren(child, revealFrom, skip)
      next.push(child)
      continue
    }

    if (insideSkippedTag || child.type !== 'text' || !child.value) {
      next.push(child)
      continue
    }

    const start = child.position?.start?.offset
    const end = child.position?.end?.offset
    if (start === undefined || end === undefined || end <= revealFrom) {
      next.push(child)
      continue
    }

    if (end - start !== child.value.length) {
      next.push(createRevealSpan(child.value))
      changed = true
      continue
    }

    const splitAt = Math.max(0, revealFrom - start)
    if (splitAt > 0) {
      next.push({ type: 'text', value: child.value.slice(0, splitAt) })
    }
    next.push(...splitIntoRevealNodes(child.value.slice(splitAt)))
    changed = true
  }

  if (changed) {
    node.children = next
  }
}

/**
 * Builds a rehype plugin that animates everything after `revealFrom`, an offset
 * into the block's own markdown source.
 */
export function createStreamingRevealPlugin(revealFrom: number) {
  return function streamingRevealPlugin() {
    return (tree: HastNode): void => {
      revealChildren(tree, revealFrom, false)
    }
  }
}
