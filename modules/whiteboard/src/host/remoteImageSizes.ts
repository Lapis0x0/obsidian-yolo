// The sizes of the images on the web that cards show, as the browser found
// them when it showed them: what the typesetter lays such an image out by
// (../ui/gpu/imageSizes.ts) without the board ever asking for it itself.
//
// A card's DOM loads an image on the web as any page does. Its size can be
// read then (`naturalWidth`) and is kept here, on this device, for every
// board; its pixels cannot be — a page may not read another site's image —
// so it is only ever drawn where the browser draws it. Nothing here asks the
// web for anything: an image no card has shown yet has no size here.
//
// Device-local private storage: a few numbers per image, about what this
// device's browser saw.

type PrivateScope = YoloModuleHostApiV1['privateStorage']['deviceLocal']

const KEY = 'remote-image-sizes.json'
/** Images remembered: the ones learned most recently. */
const MAX_IMAGES = 4000
/** How long after a size is learned what is kept is written. */
const WRITE_DELAY_MS = 2000

export type RemoteSize = Readonly<{ w: number; h: number }>

/** What an image on the web is kept by: its address without a fragment,
 * as the browser resolves it. */
export function remoteImageKey(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch {
    return url
  }
}

export class RemoteImageSizes {
  private readonly sizes = new Map<string, RemoteSize>()
  private readonly listeners = new Set<(key: string) => void>()
  private loaded = false
  private loading = false
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  /** Changes whenever a size is learned: a picture laid out before it may
   * have left the image out. */
  revision = 0

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
        const meanwhile = [...this.sizes]
        this.sizes.clear()
        for (const [key, value] of Object.entries(stored ?? {})) {
          if (
            Array.isArray(value) &&
            typeof value[0] === 'number' &&
            typeof value[1] === 'number' &&
            value[0] > 0 &&
            value[1] > 0
          ) {
            this.sizes.set(key, { w: value[0], h: value[1] })
          }
        }
        for (const [key, size] of meanwhile) this.set(key, size)
        this.loaded = true
        this.revision += 1
        for (const key of this.sizes.keys()) this.notify(key)
      })
      .catch((error: unknown) => {
        this.loaded = true
        this.reportError('remote image sizes', error)
      })
  }

  /** The size of the image at `url` as the browser last showed it; null
   * when no card has shown it yet. */
  get(url: string): RemoteSize | null {
    return this.sizes.get(remoteImageKey(url)) ?? null
  }

  /** The browser showed the image at `url` at its own size `size`. */
  learn(url: string, size: RemoteSize): void {
    if (size.w <= 0 || size.h <= 0) return
    const key = remoteImageKey(url)
    const known = this.sizes.get(key)
    if (known && known.w === size.w && known.h === size.h) return
    this.set(key, size)
    this.revision += 1
    this.notify(key)
    this.scheduleWrite()
  }

  /** Calls `listener` with each image's key whose size is learned. */
  subscribe(listener: (key: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.writeTimer !== null) clearTimeout(this.writeTimer)
    this.writeTimer = null
    if (this.loaded) void this.write()
  }

  private set(key: string, size: RemoteSize): void {
    // Insertion order is the order learned: the oldest go first.
    this.sizes.delete(key)
    this.sizes.set(key, size)
    while (this.sizes.size > MAX_IMAGES) {
      const oldest = this.sizes.keys().next().value
      if (oldest === undefined) break
      this.sizes.delete(oldest)
    }
  }

  private notify(key: string): void {
    for (const listener of this.listeners) listener(key)
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== null) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      // Not over what is kept before it has been read.
      if (this.loaded) void this.write()
      else this.scheduleWrite()
    }, WRITE_DELAY_MS)
  }

  private async write(): Promise<void> {
    const out: Record<string, [number, number]> = {}
    for (const [key, size] of this.sizes) out[key] = [size.w, size.h]
    try {
      await this.storage.writeJson(KEY, out)
    } catch (error) {
      this.reportError('remote image sizes', error)
    }
  }
}
