// How wide the reading panel was last left (ui/pdf/readerPanel.ts), kept
// for every board on this device.
//
// Device-local private storage rather than the board file or synced
// settings: a panel width is about this screen, not about the board, and a
// board file that changed every time someone dragged a divider would be a
// sync conflict waiting to happen. One value for all boards, because the
// question it answers — "how much of my screen do I give to reading" — does
// not depend on which board is open.

type PrivateScope = YoloModuleHostApiV1['privateStorage']['deviceLocal']

const KEY = 'reader-panel.json'

export class ReaderPanelPrefs {
  private width: number | null = null
  private loading = false

  constructor(
    private readonly storage: PrivateScope,
    private readonly reportError: (stage: string, error: unknown) => void,
  ) {}

  /** Reads the stored width, once; until it lands, `getWidth` gives the
   * default. */
  load(): void {
    if (this.loading) return
    this.loading = true
    void this.storage
      .readJson<{ width?: unknown }>(KEY)
      .then((stored) => {
        const width = stored?.width
        if (this.width === null && typeof width === 'number' && width > 0) {
          this.width = width
        }
      })
      .catch((error: unknown) => {
        // Asked again by the next board opened.
        this.loading = false
        this.reportError('reader panel prefs', error)
      })
  }

  getWidth(fallback: number): number {
    return this.width ?? fallback
  }

  setWidth(width: number): void {
    if (width === this.width) return
    this.width = width
    void this.storage
      .writeJson(KEY, { width })
      .catch((error: unknown) => this.reportError('reader panel prefs', error))
  }
}
