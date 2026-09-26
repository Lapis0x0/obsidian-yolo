// Whether the minimap (ui/canvas/minimap.ts) is wanted at all, kept for
// every board on this device.
//
// Device-local private storage, like the reading panel's width
// (./readerPanelPrefs.ts): whether a 200-pixel map in the corner is worth its
// room is a question about this screen — welcome on a monitor, in the way on
// a phone — not about the board, and not about the person everywhere. One
// value for all boards, and every open board follows a change made in any of
// them (`subscribe`), since each shows the same switch.

type PrivateScope = YoloModuleHostApiV1['privateStorage']['deviceLocal']

const KEY = 'minimap.json'

export class MinimapPrefs {
  private visible: boolean | null = null
  private loading = false
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly storage: PrivateScope,
    private readonly reportError: (stage: string, error: unknown) => void,
  ) {}

  /** Reads the stored choice, once; until it lands, the minimap is on. */
  load(): void {
    if (this.loading) return
    this.loading = true
    void this.storage
      .readJson<{ visible?: unknown }>(KEY)
      .then((stored) => {
        const visible = stored?.visible
        if (this.visible === null && typeof visible === 'boolean') {
          this.visible = visible
          this.notify()
        }
      })
      .catch((error: unknown) => {
        // Asked again by the next board opened.
        this.loading = false
        this.reportError('minimap prefs', error)
      })
  }

  isVisible(): boolean {
    return this.visible ?? true
  }

  setVisible(visible: boolean): void {
    if (visible === this.isVisible()) return
    this.visible = visible
    this.notify()
    void this.storage
      .writeJson(KEY, { visible })
      .catch((error: unknown) => this.reportError('minimap prefs', error))
  }

  /** Runs `onChange` whenever the choice changes, until disposed. */
  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange)
    return () => {
      this.listeners.delete(onChange)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
