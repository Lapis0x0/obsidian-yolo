// Undo/redo for a board, as a linear list of steps — each step what it
// changed, file by file (domain/portals.ts's `BoardChanges`).
//
// Changes rather than snapshots, because a board is not only edited here.
// What is behind a portal is another file, which may be open in its own tab
// or behind a portal on another board, and worked on there in between; and
// this board may be behind a portal somewhere else. A snapshot put back
// would put back everything as it was, theirs too. A step puts back only the
// nodes and edges it touched, as they were before it — and those are cheap
// to keep: every mutation goes through domain/operations.ts, which returns a
// new Board sharing every object it did not change, so a step is the few
// objects that differ.
//
// Deliberately ignorant of the camera, which no step holds: a viewport that
// jumps away is the least welcome thing an undo can do.
//
// DOM-free like every other domain/ module, so the whole undo model is
// testable without a canvas.

import type { BoardNode, NodeId } from './fileFormat'
import {
  type BoardChanges,
  type Change,
  type FileChanges,
  invertChanges,
  mergeChanges,
} from './portals'

/**
 * How many steps back the board remembers. Steps are cheap (see above), so
 * this is about how far back a user could plausibly want to go, not about
 * memory.
 */
export const HISTORY_MAX_ENTRIES = 100

export class BoardHistory {
  private readonly steps: BoardChanges[] = []
  /** How many of `steps` are done: the next undo undoes `steps[done - 1]`. */
  private done = 0
  /**
   * What made the newest step, when that thing is still running. A further
   * push carrying the same key joins that step instead of adding one — an
   * editing session commits its text many times over (throttled writes plus
   * a final flush on blur) and all of it is one thing the user did, so it has
   * to be one thing to undo.
   */
  private topKey: string | null = null

  /**
   * @param onChange Called whenever what `canUndo` / `canRedo` answer may
   * have changed — for a control that greys out with nothing to undo.
   */
  constructor(
    private readonly max: number = HISTORY_MAX_ENTRIES,
    private readonly onChange: () => void = () => undefined,
  ) {}

  /** Forgets every step. Used when the board's file is loaded or rewritten
   * from outside: steps taken on the previous content would be put on
   * content they were not taken on. */
  reset(): void {
    this.steps.length = 0
    this.done = 0
    this.topKey = null
    this.onChange()
  }

  push(changes: BoardChanges, coalesceKey?: string): void {
    if (changes.size === 0) return
    if (
      this.done > 0 &&
      this.done === this.steps.length &&
      coalesceKey !== undefined &&
      coalesceKey === this.topKey
    ) {
      this.steps[this.done - 1] = mergeChanges(
        this.steps[this.done - 1],
        changes,
      )
      return
    }
    // Anything that was ahead of us is a future we just stopped walking into.
    this.steps.length = this.done
    this.steps.push(changes)
    if (this.steps.length > this.max) this.steps.shift()
    this.done = this.steps.length
    this.topKey = coalesceKey ?? null
    this.onChange()
  }

  canUndo(): boolean {
    return this.done > 0
  }

  canRedo(): boolean {
    return this.done < this.steps.length
  }

  /** What undoing the last step changes; null with nothing to undo. */
  undo(): BoardChanges | null {
    if (!this.canUndo()) return null
    this.done -= 1
    this.topKey = null
    this.onChange()
    return invertChanges(this.steps[this.done])
  }

  /** What redoing the next step changes; null with nothing to redo. */
  redo(): BoardChanges | null {
    if (!this.canRedo()) return null
    this.done += 1
    this.topKey = null
    this.onChange()
    return this.steps[this.done - 1]
  }
}

/**
 * `changes` — an undo's or a redo's — with every HTML card they put back
 * keeping the page memory it has now (fileFormat.ts's `startScroll` and
 * `storage`), rather than the memory it had when the step was taken.
 *
 * A page's scroll and its `localStorage` are where its reader left it, not
 * an edit: no step records them changing (canvas.ts writes them outside the
 * history), and no undo may take them back either — taking them back would
 * also rebuild the card and reload its page, losing more than it restores.
 * So the memory a step happens to carry, which is whatever the card had when
 * the step was taken, is replaced by the card's current one wherever the
 * card is still there. A card the step brings back from deletion has no
 * current memory and comes back with what it had when it was deleted.
 *
 * Where the memory was the only difference, the card is given back as the
 * very object the file has now, so the step does not change it at all.
 * `current` is a node as its file has it now.
 */
export function keepPageMemory(
  changes: BoardChanges,
  current: (file: string, id: NodeId) => BoardNode | undefined,
): BoardChanges {
  let kept: Map<string, FileChanges> | null = null
  for (const [file, fileChanges] of changes) {
    let nodes: Map<NodeId, Change<BoardNode>> | null = null
    for (const [id, change] of fileChanges.nodes) {
      const target = change.after
      const now = current(file, id)
      if (target?.type !== 'file' || now?.type !== 'file') continue
      const after = withMemoryOf(target, now)
      if (after === target) continue
      nodes ??= new Map(fileChanges.nodes)
      nodes.set(id, { ...change, after })
    }
    if (!nodes) continue
    kept ??= new Map(changes)
    kept.set(file, { ...fileChanges, nodes })
  }
  return kept ?? changes
}

/** `target` with `now`'s page memory: `target` itself when they already
 * agree, `now` itself when that memory was all they disagreed on. */
function withMemoryOf(
  target: BoardNode & { type: 'file' },
  now: BoardNode & { type: 'file' },
): BoardNode {
  if (
    target.startScroll === now.startScroll &&
    target.storage === now.storage
  ) {
    return target
  }
  const next: { startScroll?: number; storage?: unknown } = { ...target }
  delete next.startScroll
  delete next.storage
  if (now.startScroll !== undefined) next.startScroll = now.startScroll
  if (now.storage !== undefined) next.storage = now.storage
  return sameFields(next, now) ? now : (next as BoardNode)
}

function sameFields(a: object, b: object): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (
      (a as Record<string, unknown>)[key] !==
      (b as Record<string, unknown>)[key]
    ) {
      return false
    }
  }
  return true
}
