// The images on the web that cards have shown on this device: each one's
// size, and its bytes — what the typesetter lays such an image out by
// (../ui/gpu/imageSizes.ts) and what its picture and the GPU scene draw it
// from (../ui/pictures/imageFiles.ts, ../ui/gpu/nearImages.ts).
//
// A card's DOM loads an image on the web as any page does, and its size can
// be read then (`naturalWidth`). Its pixels cannot: a page may not read
// another site's image, and one drawn into a canvas leaves the canvas
// unreadable and unfit for the GPU. So once the DOM has shown an image — and
// only then: nothing here goes looking for an image nobody has seen — its
// bytes are fetched again through the host (`network.requestBinary`, which no
// site's CORS policy applies to), once, and kept. An image whose bytes are not
// kept is left to the DOM near to, as it was.
//
// Device-local private storage: an index of the images, newest last, written
// whenever it changes, and a file of bytes for each kept one, within a budget
// — the longest unseen go first, keeping their size.

import { hashText } from '../domain/hash'

type PrivateScope = YoloModuleHostApiV1['privateStorage']['deviceLocal']
type Network = Pick<YoloModuleHostApiV1['network'], 'requestBinary'>

const ROOT = 'remote-images'
const INDEX = `${ROOT}/index.json`
/** Images remembered: the ones seen most recently. */
const MAX_IMAGES = 4000
/** Bytes of images kept. */
const BUDGET_BYTES = 100 * 1024 * 1024
/** Past this, an image is not kept: it stays the DOM's. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
/** Images fetched at once. */
const FETCHES = 2

export type RemoteSize = Readonly<{ w: number; h: number }>

/** An image as it is remembered: its size, and how many bytes of it are
 * kept — none when they are not. */
type Entry = { w: number; h: number; bytes: number }

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

export class RemoteImages {
  /** Insertion order is the order seen: the longest unseen first. */
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<(key: string) => void>()
  /** Asked for once each in a session, whatever came of it. */
  private readonly asked = new Set<string>()
  private readonly queue: string[] = []
  private fetching = 0
  private keptBytes = 0
  private loaded = false
  private loading = false
  private disposed = false
  /** The index changed since it was last written. */
  private dirty = false
  private writing = false
  /** Changes whenever what is known of an image does — its size learned,
   * its bytes come or gone: a picture made before may have left it out. */
  revision = 0

  constructor(
    private readonly storage: PrivateScope,
    private readonly network: Network,
    private readonly reportError: (stage: string, error: unknown) => void,
  ) {}

  /** Reads what is kept, once. */
  load(): void {
    if (this.loading) return
    this.loading = true
    void this.storage
      .readJson<Record<string, unknown>>(INDEX)
      .then((stored) => {
        const meanwhile = [...this.entries]
        this.entries.clear()
        this.keptBytes = 0
        for (const [key, value] of Object.entries(stored ?? {})) {
          const entry = entryOf(value)
          if (entry) this.put(key, entry)
        }
        for (const [key, entry] of meanwhile) {
          const before = this.entries.get(key)
          this.put(key, { ...entry, bytes: before?.bytes ?? entry.bytes })
        }
        this.loaded = true
        for (const key of this.entries.keys()) this.notify(key)
        if (this.dirty) this.scheduleWrite()
        this.pump()
      })
      .catch((error: unknown) => {
        this.loaded = true
        this.reportError('remote images', error)
        this.pump()
      })
  }

  /** The image's own size, as the browser last showed it; null when no
   * card has shown it yet. */
  get(url: string): RemoteSize | null {
    const entry = this.entries.get(remoteImageKey(url))
    return entry ? { w: entry.w, h: entry.h } : null
  }

  /** Whether the image's bytes are kept: whether it can be drawn other
   * than by the browser. */
  kept(url: string): boolean {
    return (this.entries.get(remoteImageKey(url))?.bytes ?? 0) > 0
  }

  /** The browser showed the image at `url`, at its own size `size`: it is
   * remembered, and its bytes fetched if they are not kept. */
  shown(url: string, size: RemoteSize): void {
    if (size.w <= 0 || size.h <= 0) return
    const key = remoteImageKey(url)
    const known = this.entries.get(key)
    if (!known || known.w !== size.w || known.h !== size.h) {
      this.put(key, { w: size.w, h: size.h, bytes: known?.bytes ?? 0 })
      this.notify(key)
      this.scheduleWrite()
    }
    if ((known?.bytes ?? 0) > 0 || this.asked.has(key)) return
    this.asked.add(key)
    this.queue.push(key)
    this.pump()
  }

  /** The image's kept bytes; rejects when they are not kept. */
  async bytes(url: string): Promise<ArrayBuffer> {
    const key = remoteImageKey(url)
    const entry = this.entries.get(key)
    if (!entry || entry.bytes === 0) throw new Error('Image not kept')
    const data = await this.storage.readBinary(fileOf(key))
    if (data) return data
    // Gone from under the index: the DOM shows it until it is fetched again.
    this.forget(key, entry)
    this.notify(key)
    this.scheduleWrite()
    throw new Error('Image not kept')
  }

  /** Calls `listener` with each image's key whose size is learned or whose
   * bytes come or go. */
  subscribe(listener: (key: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    this.queue.length = 0
  }

  /** Fetches what is waiting, a few at a time, once the index is read. */
  private pump(): void {
    while (
      this.loaded &&
      !this.disposed &&
      this.fetching < FETCHES &&
      this.queue.length > 0
    ) {
      const key = this.queue.shift()
      if (key === undefined) break
      if (this.kept(key)) continue
      this.fetching += 1
      void this.fetch(key).finally(() => {
        this.fetching -= 1
        this.pump()
      })
    }
  }

  private async fetch(key: string): Promise<void> {
    let body: ArrayBuffer
    try {
      const response = await this.network.requestBinary(key)
      if (
        response.contentType !== null &&
        !/^image\//i.test(response.contentType)
      ) {
        return
      }
      body = response.body
    } catch {
      // Offline, or refused: the DOM goes on showing it.
      return
    }
    if (this.disposed) return
    if (body.byteLength === 0 || body.byteLength > MAX_IMAGE_BYTES) return
    try {
      await this.storage.writeBinary(fileOf(key), body)
    } catch (error) {
      this.reportError('remote image write', error)
      return
    }
    const entry = this.entries.get(key)
    if (this.disposed || !entry) return
    this.put(key, { ...entry, bytes: body.byteLength })
    this.trim(key)
    this.notify(key)
    this.scheduleWrite()
  }

  /** Remembers `entry` as the most recently seen. */
  private put(key: string, entry: Entry): void {
    const before = this.entries.get(key)
    if (before) this.keptBytes -= before.bytes
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.keptBytes += entry.bytes
    while (this.entries.size > MAX_IMAGES) {
      const [oldest, gone] = this.entries.entries().next().value ?? []
      if (oldest === undefined || gone === undefined) break
      this.forget(oldest, gone)
      this.entries.delete(oldest)
    }
  }

  /** Past the budget, the bytes of the longest unseen go — never `keep`'s. */
  private trim(keep: string): void {
    for (const [key, entry] of this.entries) {
      if (this.keptBytes <= BUDGET_BYTES) return
      if (key === keep || entry.bytes === 0) continue
      this.forget(key, entry)
      this.notify(key)
    }
  }

  /** Lets go of an image's bytes; its size stays. */
  private forget(key: string, entry: Entry): void {
    if (entry.bytes === 0) return
    this.keptBytes -= entry.bytes
    entry.bytes = 0
    void this.storage
      .removeFile(fileOf(key))
      .catch((error: unknown) => this.reportError('remote image remove', error))
  }

  private notify(key: string): void {
    this.revision += 1
    for (const listener of this.listeners) listener(key)
  }

  /** Writes the index whole, at once — and once more after a write in
   * progress, for what changed during it. Not over what is kept before it
   * has been read. */
  private scheduleWrite(): void {
    this.dirty = true
    if (!this.loaded || this.writing || this.disposed) return
    this.writing = true
    void (async () => {
      while (this.dirty && !this.disposed) {
        this.dirty = false
        const out: Record<string, [number, number, number]> = {}
        for (const [key, { w, h, bytes }] of this.entries) {
          out[key] = [w, h, bytes]
        }
        try {
          await this.storage.writeJson(INDEX, out)
        } catch (error) {
          this.reportError('remote images', error)
        }
      }
      this.writing = false
    })()
  }
}

function fileOf(key: string): string {
  return `${ROOT}/${hashText(key)}`
}

function entryOf(value: unknown): Entry | null {
  if (!Array.isArray(value)) return null
  const [w, h, bytes = 0] = value as unknown[]
  if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) {
    return null
  }
  return { w, h, bytes: typeof bytes === 'number' && bytes > 0 ? bytes : 0 }
}
