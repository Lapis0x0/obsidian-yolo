/**
 * Whether frames are arriving on time, judged against the display they are
 * drawn for rather than a fixed bar.
 *
 * A frame's interval is read off the timestamps `requestAnimationFrame`
 * hands its callback, which tick in display periods: 8.3ms at 120Hz, 16.7ms
 * at 60Hz. A fixed bar fits one display only — 20ms, right for 60Hz, lets a
 * 120Hz frame run more than twice its period and still count as on time
 * (measured 2026-11-08: a 60ms frame of card builds began right after a
 * 26ms one). The period is the shortest interval seen lately: frames
 * never come faster than the display, and a board that keeps up shows it
 * many times a second.
 */
export class FramePace {
  private readonly recent: number[] = []
  private next = 0

  constructor(
    /** How many periods a frame may take and still be on time. */
    private readonly periods: number,
  ) {}

  /** Takes the interval since the last frame, ms; whether it was on time. */
  onTime(interval: number): boolean {
    // The first frame after a pause has nothing to go by, and an interval
    // shorter than any display's is a second callback in one frame.
    if (interval < MIN_PERIOD_MS) return true
    if (this.recent.length < WINDOW) this.recent.push(interval)
    else this.recent[this.next] = interval
    this.next = (this.next + 1) % WINDOW
    return interval <= Math.min(...this.recent) * this.periods
  }
}

/** How many intervals the period is read from: half a second at 60Hz. */
const WINDOW = 32
/** Shorter than any display's period (240Hz is 4.2ms). */
const MIN_PERIOD_MS = 4
