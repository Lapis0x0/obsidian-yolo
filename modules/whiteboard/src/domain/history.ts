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

import { type BoardChanges, invertChanges, mergeChanges } from './portals'

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
