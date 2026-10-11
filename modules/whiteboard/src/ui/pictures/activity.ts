// The line a board puts in the host's activity list (Host API
// `background`) while it is making pictures (./pictures.ts): "processing
// whiteboard cache", with the board's name in its detail. One per board.
//
// Only for making pictures, not for reading kept ones back, which is over
// before anyone could read the line. And only once the making has gone on for
// a while (`SHOW_AFTER_MS`): a board that makes a picture or two must not
// flash an entry in and out of the list. It goes the moment the making is
// done, or the board closes. A board being moved pauses the making but is
// still busy with it (`Pictures`' `onBusy`), so the line stays rather than
// coming and going with every pan.

/** How long the making has to have gone on before the line is shown. */
const SHOW_AFTER_MS = 1000

export type PictureActivityDeps = Readonly<{
  win: Window
  background: YoloModuleHostApiV1['background']
  /** The board's path, which names its line, and the name it is shown by. */
  board: () => Readonly<{ path: string; name: string }> | null
  /** The line's title, in the language of the moment it is shown. */
  title: () => string
  reportError: (stage: string, error: unknown) => void
}>

export class PictureActivity {
  private timer: number | null = null
  /** The id the line was shown under, while it is. */
  private shown: string | null = null

  constructor(private readonly deps: PictureActivityDeps) {}

  /** Whether the board has pictures to make. */
  setBusy(busy: boolean): void {
    if (busy) {
      if (this.timer !== null || this.shown !== null) return
      this.timer = this.deps.win.setTimeout(() => {
        this.timer = null
        this.show()
      }, SHOW_AFTER_MS)
      return
    }
    this.clear()
  }

  destroy(): void {
    this.clear()
  }

  private show(): void {
    const board = this.deps.board()
    if (!board) return
    const id = `picture-cache:${board.path}`
    try {
      this.deps.background.upsert({
        id,
        title: this.deps.title(),
        detail: board.name,
        status: 'running',
      })
      this.shown = id
    } catch (error) {
      this.deps.reportError('picture cache activity', error)
    }
  }

  private clear(): void {
    if (this.timer !== null) {
      this.deps.win.clearTimeout(this.timer)
      this.timer = null
    }
    if (this.shown === null) return
    const id = this.shown
    this.shown = null
    try {
      this.deps.background.remove(id)
    } catch {
      // Only refused once the module is no longer active — its views are
      // closed after that — and the host has taken its lines down itself.
    }
  }
}
