// Where each board was last looked at on this device.
//
// A board's file has a camera of its own, and still gets the live one with
// every save (ui/canvas.ts's `getViewData`). But a pan is not an edit: saving
// for it rewrote the whole file at the end of every pan, and a board of
// thousands of cards is a megabyte to serialize and a modify event for every
// open board to look through. Without that save, the camera reached the file
// only with the next edit or when the board closed — and quitting the app
// closes no board. So the camera is kept here as well, on the device, at the
// end of each gesture: a few numbers per board.
//
// What opens a board is this, when there is one, and the file's otherwise —
// on another device, or the first time. Device-local private storage, like
// the minimap's switch (./minimapPrefs.ts): where someone was looking is a
// question about this screen.

import type { Camera } from '../domain/fileFormat'

type PrivateScope = YoloModuleHostApiV1['privateStorage']['deviceLocal']

const KEY = 'board-cameras.json'
/** Boards remembered: the ones looked at most recently. */
const MAX_BOARDS = 200

type Stored = Camera & { at: number }

export class BoardCameras {
  /** Every board looked at, the longest unlooked-at first: what was read,
   * and what was set since. */
  private readonly cameras = new Map<string, Stored>()
  private loaded = false
  private loading = false
  /** Set before what is kept was read: written once it has been, over it. */
  private unwritten = false
  private readonly waiting = new Set<() => void>()
  /** Every write, one after another, so the last one written is the last
   * one made. */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: PrivateScope,
    private readonly reportError: (stage: string, error: unknown) => void,
  ) {}

  /** Reads what is kept, once. */
  load(): void {
    if (this.loading) return
    this.loading = true
    void this.storage
      .readJson<Record<string, unknown>>(KEY)
      .then((stored) => {
        // Set meanwhile: newer than anything read, so it goes after it.
        const meanwhile = [...this.cameras]
        this.cameras.clear()
        for (const [path, value] of Object.entries(stored ?? {})) {
          const camera = parseStored(value)
          if (camera) this.cameras.set(path, camera)
        }
        for (const [path, camera] of meanwhile) this.remember(path, camera)
        this.loaded = true
        if (this.unwritten) this.write()
        for (const done of this.waiting) done()
        this.waiting.clear()
      })
      .catch((error: unknown) => {
        // Asked again by the next board opened.
        this.loading = false
        this.reportError('board cameras', error)
      })
  }

  /** Where `path` was last looked at here: undefined until what is kept has
   * been read, null when it was never looked at. */
  get(path: string): Camera | null | undefined {
    if (!this.loaded) return undefined
    const stored = this.cameras.get(path)
    return stored ? { x: stored.x, y: stored.y, scale: stored.scale } : null
  }

  /** Runs `done` once what is kept has been read — at once if it has. */
  whenLoaded(done: () => void): () => void {
    if (this.loaded) {
      done()
      return () => undefined
    }
    this.waiting.add(done)
    return () => {
      this.waiting.delete(done)
    }
  }

  set(path: string, camera: Camera): void {
    this.remember(path, { ...camera, at: Date.now() })
    // Written whole: not over what is kept before it has been read.
    if (this.loaded) this.write()
    else this.unwritten = true
  }

  private remember(path: string, camera: Stored): void {
    this.cameras.delete(path)
    this.cameras.set(path, camera)
    for (const oldest of this.cameras.keys()) {
      if (this.cameras.size <= MAX_BOARDS) break
      this.cameras.delete(oldest)
    }
  }

  private write(): void {
    this.unwritten = false
    const snapshot = Object.fromEntries(this.cameras)
    this.writes = this.writes
      .then(() => this.storage.writeJson(KEY, snapshot))
      .catch((error: unknown) => this.reportError('board cameras', error))
  }
}

function parseStored(value: unknown): Stored | null {
  if (typeof value !== 'object' || value === null) return null
  const { x, y, scale, at } = value as Record<string, unknown>
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof scale !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !(scale > 0)
  ) {
    return null
  }
  return { x, y, scale, at: typeof at === 'number' ? at : 0 }
}
