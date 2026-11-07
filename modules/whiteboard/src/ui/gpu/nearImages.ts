// The images in the cards the GPU scene draws, at the size they show at:
// near to, an image is shown wider than its picture (../pictures/imageFiles.ts,
// made for the overview: 480 pixels), so its file is decoded again at the
// width it needs — in steps, so that zooming does not decode it at every
// width it passes — and its picture stands in until that arrives.
//
// `createImageBitmap` decodes off the main thread and scales on the way.
// What is decoded is kept up to a budget of bytes, the least lately drawn
// let go first; a file that changes is decoded again.

/** Widths an image is decoded at, in device pixels: the smallest that
 * covers what it shows at, never wider than the image itself. */
const STEPS = [512, 1024, 2048, 4096]
/** Bytes of decoded images kept. */
const BUDGET = 192 * 1024 * 1024

type Decoded = { bitmap: ImageBitmap; width: number; usedAt: number }

export type NearImagesDeps = Readonly<{
  win: Window
  vault: Pick<YoloModuleHostApiV1['vault'], 'readBinary'>
  /** An image's own width, when it is known (./imageSizes.ts). */
  ownWidth: (path: string) => number | null
  /** The image's picture, standing in until a decode arrives. */
  picture: (path: string) => ImageBitmap | null
  /** A decode arrived: the scene draws again. */
  onDecoded: () => void
}>

export class NearImages {
  private readonly decoded = new Map<string, Decoded>()
  private readonly decoding = new Map<string, number>()
  private bytes = 0
  private clock = 0

  constructor(private readonly deps: NearImagesDeps) {}

  /** The best bitmap for `path` shown `devicePx` wide: a decode that covers
   * it, or else the nearest thing there is while one is made. */
  get(path: string, devicePx: number): ImageBitmap | null {
    this.clock += 1
    const want = this.stepFor(path, devicePx)
    const have = this.decoded.get(path)
    if (have) have.usedAt = this.clock
    const picture = this.deps.picture(path)
    // The picture is enough while it is as wide as what it shows.
    if (picture && picture.width >= devicePx && (!have || have.width < want)) {
      return picture
    }
    if (!have || have.width < want) this.decode(path, want)
    if (have && (!picture || have.width >= picture.width)) return have.bitmap
    return picture ?? have?.bitmap ?? null
  }

  /** A file changed: what was decoded of it goes. */
  fileChanged(path: string): void {
    const have = this.decoded.get(path)
    if (!have) return
    this.release(path, have)
  }

  destroy(): void {
    for (const [path, have] of [...this.decoded]) this.release(path, have)
  }

  private stepFor(path: string, devicePx: number): number {
    const own = this.deps.ownWidth(path) ?? Infinity
    const step = STEPS.find((s) => s >= devicePx) ?? STEPS[STEPS.length - 1]
    return Math.min(step, own)
  }

  private decode(path: string, width: number): void {
    if ((this.decoding.get(path) ?? 0) >= width) return
    this.decoding.set(path, width)
    void (async () => {
      try {
        const data = await this.deps.vault.readBinary(path)
        const bitmap = await this.deps.win.createImageBitmap(new Blob([data]), {
          resizeWidth: Math.round(width),
          resizeQuality: 'high',
        })
        if (this.decoding.get(path) !== width) {
          bitmap.close()
          return
        }
        const before = this.decoded.get(path)
        if (before) this.release(path, before)
        this.decoded.set(path, { bitmap, width, usedAt: this.clock })
        this.bytes += bitmap.width * bitmap.height * 4
        this.trim()
        this.deps.onDecoded()
      } catch {
        // Left to its picture.
      } finally {
        if (this.decoding.get(path) === width) this.decoding.delete(path)
      }
    })()
  }

  private trim(): void {
    if (this.bytes <= BUDGET) return
    const oldest = [...this.decoded].sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [path, have] of oldest) {
      if (this.bytes <= BUDGET) return
      this.release(path, have)
    }
  }

  private release(path: string, have: Decoded): void {
    this.decoded.delete(path)
    this.bytes -= have.bitmap.width * have.bitmap.height * 4
    have.bitmap.close()
  }
}
