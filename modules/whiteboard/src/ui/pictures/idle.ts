// Time the board's window has to spare, handed out a slice at a time to
// the main-thread work of making a picture (./imageFiles.ts, ./cardPictures.ts).
//
// Making a picture is a few steps, a few milliseconds of main-thread work
// each, with waits between them (a file read, an image decode). Each step
// waits here for an idle period of the board's own window
// (`requestIdleCallback`) with at least `minMs` left in it, and does its work
// inside that period: never in a frame that has something else to do. It
// also waits for the board to be ready for it — still, and its window shown:
// a window in the background runs this work three to ten times slower, and a
// board being moved has better uses for its idle time.
//
// Popout safety: the idle callbacks and the timers are the board's window's.

/** How long an idle period must have left for a step to start in it. The
 * longest step measured (copying a card and laying out its picture) took
 * about 5 ms; and a board runs a frame loop at all times, so on a 120 Hz
 * display no idle period is longer than the 5–7 ms left between two of its
 * frames (measured) — asking for more than that would wait for ever. */
const IDLE_SLICE_MIN_MS = 4
/** How often a board that is not ready is asked again. */
const NOT_READY_RETRY_MS = 120

export class IdleSlices {
  private destroyed = false
  /** The waits in flight, each with how to cancel it. */
  private readonly waits = new Map<(ok: boolean) => void, () => void>()

  constructor(
    private readonly win: Window,
    /** Whether work may run now: the board still, its window shown. */
    private readonly ready: () => boolean,
    private readonly minMs = IDLE_SLICE_MIN_MS,
  ) {}

  /**
   * Resolves inside an idle period of the window with time to spare, once
   * the board is ready: true then, false if this is destroyed first. Work
   * done straight after the `await` runs in that period — the continuation
   * runs in the microtasks that end the idle callback's task.
   */
  next(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.destroyed) {
        resolve(false)
        return
      }
      const ask = (): void => {
        const handle = this.win.requestIdleCallback((deadline) => {
          if (this.destroyed) return
          if (!this.ready()) {
            wait()
            return
          }
          if (deadline.timeRemaining() < this.minMs) {
            ask()
            return
          }
          this.waits.delete(resolve)
          resolve(true)
        })
        this.waits.set(resolve, () => this.win.cancelIdleCallback(handle))
      }
      const wait = (): void => {
        const handle = this.win.setTimeout(ask, NOT_READY_RETRY_MS)
        this.waits.set(resolve, () => this.win.clearTimeout(handle))
      }
      ask()
    })
  }

  destroy(): void {
    this.destroyed = true
    for (const [resolve, cancel] of this.waits) {
      cancel()
      resolve(false)
    }
    this.waits.clear()
  }
}
