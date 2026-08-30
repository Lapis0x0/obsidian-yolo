// Undo/redo for a board, as a linear stack of whole-board snapshots.
//
// Snapshots rather than inverse operations, because a snapshot here is almost
// free: every mutation goes through domain/operations.ts, which returns a new
// Board sharing every object it did not change (the repository's "an object's
// reference changes if and only if its content changes" rule). Two snapshots
// either side of a card move differ by one card object and two arrays — not by
// a copy of the board. Inverse operations would buy nothing for that price and
// would need an undo written, and kept correct, for every future primitive.
// (Obsidian Canvas keeps whole-data snapshots for the same reason.)
//
// Deliberately ignorant of the camera: what belongs in a snapshot is decided
// by the caller, and the canvas restores the live camera over whatever a
// snapshot carries — a viewport that jumps away is the least welcome thing an
// undo can do.
//
// DOM-free like every other domain/ module, so the whole undo model is
// testable without a canvas.

import type { Board } from './fileFormat'

/**
 * How many steps back the board remembers. Snapshots are cheap (see above),
 * so this is about how far back a user could plausibly want to go, not about
 * memory.
 */
export const HISTORY_MAX_ENTRIES = 100

export class BoardHistory {
  /** Past-to-future; `entries[index]` is the state now on screen. */
  private readonly entries: Board[] = []
  private index = -1
  /**
   * What produced the newest entry, when that thing is still running. A
   * further push carrying the same key rewrites that entry instead of adding
   * one — an editing session commits its text many times over (throttled
   * writes plus a final flush on blur) and all of it is one thing the user
   * did, so it has to be one thing to undo.
   */
  private topKey: string | null = null

  constructor(private readonly max: number = HISTORY_MAX_ENTRIES) {}

  /** Starts over from `board` as the present. Used when a file is loaded or
   * reloaded: snapshots of the previous content cannot be applied to it, and
   * applying them would overwrite whatever wrote the file. */
  reset(board: Board): void {
    this.entries.length = 0
    this.entries.push(board)
    this.index = 0
    this.topKey = null
  }

  push(board: Board, coalesceKey?: string): void {
    if (this.index >= 0 && this.entries[this.index] === board) return
    if (
      this.index >= 0 &&
      coalesceKey !== undefined &&
      coalesceKey === this.topKey
    ) {
      this.entries[this.index] = board
      return
    }
    // Anything that was ahead of us is a future we just stopped walking into.
    this.entries.length = this.index + 1
    this.entries.push(board)
    if (this.entries.length > this.max) this.entries.shift()
    this.index = this.entries.length - 1
    this.topKey = coalesceKey ?? null
  }

  canUndo(): boolean {
    return this.index > 0
  }

  canRedo(): boolean {
    return this.index >= 0 && this.index < this.entries.length - 1
  }

  undo(): Board | null {
    if (!this.canUndo()) return null
    this.index -= 1
    this.topKey = null
    return this.entries[this.index]
  }

  redo(): Board | null {
    if (!this.canRedo()) return null
    this.index += 1
    this.topKey = null
    return this.entries[this.index]
  }
}
