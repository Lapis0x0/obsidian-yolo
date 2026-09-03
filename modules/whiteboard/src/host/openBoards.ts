// Which boards are on screen right now.
//
// `edit_board` edits the open view when there is one and the file when there
// is not (ui/canvas.ts's agent edit surface explains why). This is how it
// finds out which case it is in.
//
// A canvas is *asked* which board it is showing rather than filed under a
// path, so a rename — which the module already rewrites references for —
// needs no bookkeeping here at all. The set is created per activation and
// handed to whoever needs it rather than living at module scope, so a
// deactivate leaves nothing behind.

import type { WhiteboardCanvas } from '../ui/canvas'

export class OpenBoards {
  private readonly canvases = new Set<WhiteboardCanvas>()

  /** Returns the disposer the view's own teardown calls. */
  add(canvas: WhiteboardCanvas): () => void {
    this.canvases.add(canvas)
    return () => {
      this.canvases.delete(canvas)
    }
  }

  /**
   * The view showing `path`, or null.
   *
   * One board can be open in two leaves at once (a split, a popout). Either
   * is equally correct to edit — both are views onto the same file, and the
   * other one reloads from it — so this takes the first rather than pretending
   * the ambiguity is resolvable.
   */
  find(path: string): WhiteboardCanvas | null {
    for (const canvas of this.canvases) {
      if (canvas.getBoardPath() === path) return canvas
    }
    return null
  }
}
