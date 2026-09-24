// One queue for every PDF page a board draws.
//
// Each reader on a board (a PDF card, or one sheet of a spread) used to
// decide on its own when to draw, two pages at a time. The engine draws on
// the main thread, in slices of up to 15ms that it resumes on the next
// animation frame — so ten readers drawing at once put ten slices into the
// same frame. A spread puts dozens of readers on screen, and a pan across it
// made 40–170ms frames of exactly that.
//
// So a reader asks here before it starts a draw. Only `limit()` draws run at
// once across the board, and when one finishes (or on any frame with room),
// the waiting reader nearest the middle of the viewport is woken to take the
// place: what is being looked at is drawn first, and a page panned past
// before its turn is never drawn at all.
//
// A waiting reader is one that asked on its latest pass and was told no. It
// withdraws at the start of every pass (and when hidden or destroyed), so
// only readers that still want to draw can hold up the others.

export type PdfDrawClient = Readonly<{
  /** Lower goes first: distance from the middle of the viewport. Read when
   * turns are decided, so it follows the camera. */
  priority: () => number
  /** Asks the reader to run a pass soon, in which it asks again. */
  wake: () => void
}>

export class PdfDrawQueue {
  private running = 0
  private readonly waiting = new Set<PdfDrawClient>()

  /** `limit` is how many draws may run at once right now; 0 holds them all. */
  constructor(private readonly limit: () => number) {}

  /**
   * Whether `client` may start a draw now. On yes the draw counts as running
   * until `finish`; on no the client waits and is woken when its turn comes.
   */
  tryStart(client: PdfDrawClient): boolean {
    if (this.running < this.limit() && this.isNext(client)) {
      this.waiting.delete(client)
      this.running += 1
      return true
    }
    this.waiting.add(client)
    return false
  }

  /** A draw that `tryStart` allowed has ended, however it ended. */
  finish(): void {
    this.running = Math.max(0, this.running - 1)
    this.pump()
  }

  /** The client no longer wants a turn (for now). */
  withdraw(client: PdfDrawClient): void {
    this.waiting.delete(client)
  }

  /**
   * Wakes as many waiting clients as there is room for, best first. Called
   * after a draw ends and once a frame by the board, since room also appears
   * when `limit()` rises — the camera stopping, a drag being let go.
   */
  pump(): void {
    const room = this.limit() - this.running
    if (room <= 0 || this.waiting.size === 0) return
    const best = [...this.waiting]
      .map((client) => ({ client, priority: client.priority() }))
      .sort((a, b) => a.priority - b.priority)
      .slice(0, room)
    for (const { client } of best) client.wake()
  }

  /** Whether `client` is among the first as many waiting clients as there
   * is room for — or no one is waiting ahead of it. */
  private isNext(client: PdfDrawClient): boolean {
    if (this.waiting.size === 0) return true
    const room = this.limit() - this.running
    const own = client.priority()
    let ahead = 0
    for (const other of this.waiting) {
      if (other === client) continue
      if (other.priority() < own) ahead += 1
      if (ahead >= room) return false
    }
    return true
  }
}
