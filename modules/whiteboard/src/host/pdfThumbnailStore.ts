// The page thumbnails of PDFs (ui/pdf/thumbnails.ts), kept on this device so
// that a spread opened again — folded and unfolded, on another board, after a
// restart — shows its pages at once instead of drawing every one anew.
//
// Device-local private storage (an IndexedDB database of this vault): a
// thumbnail is made from a file and can always be made again, so it has no
// business syncing. Each version of a file — its path as last modified at a
// time — has a folder of its own: an image per page and the list of pages in
// it. An index names the folders with their size and when they were last
// used; past the budget, the files used longest ago go first, whole — a
// spread is opened as a whole, and half its pages would be worth little.
//
// A file's version is its path and modification time. Renaming a file, or a
// sync that only touches its time, costs its thumbnails being made again;
// telling files apart by their contents would cost reading every one before
// a stored picture could be shown, which is what this is here to avoid.

type PrivateScope = YoloModuleHostApiV1['privateStorage']['deviceLocal']

const ROOT = 'pdf-thumbnails'
const INDEX_KEY = `${ROOT}/index.json`
const PAGES_FILE = 'pages.txt'
/** About 20 000 pages. */
const BUDGET_BYTES = 200 * 1024 * 1024
/** How long after a change the page lists and the index are written: a
 * spread's pages come in one after another, and each write is read back. */
const FLUSH_DELAY_MS = 1500

type StoredFile = {
  readonly path: string
  readonly mtime: number
  readonly dir: string
  bytes: number
  usedAt: number
  /** The pages in the folder, read when first asked for. */
  pages: Promise<Set<number>> | null
}

type IndexRecord = Readonly<{
  dir: string
  mtime: number
  bytes: number
  usedAt: number
}>

const EMPTY: ReadonlySet<number> = new Set()

export class PdfThumbnailStore {
  private files: Promise<Map<string, StoredFile>> | null = null
  /** Every write to storage, one after another, so a folder is never
   * removed under a page being written into it. */
  private writes: Promise<unknown> = Promise.resolve()
  /** Files whose page list has changed since it was written. */
  private readonly dirty = new Set<StoredFile>()
  private indexDirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly storage: PrivateScope,
    private readonly reportError: (stage: string, error: unknown) => void,
    /** Only tests set this: filling the real budget costs 200 MB. */
    private readonly budgetBytes = BUDGET_BYTES,
  ) {}

  /** The pages stored of the file as last modified at `mtime`. An older
   * version of it is let go of here. */
  async pages(path: string, mtime: number): Promise<ReadonlySet<number>> {
    const file = await this.current(path, mtime, false)
    if (!file) return EMPTY
    file.usedAt = Date.now()
    this.markIndex()
    return new Set(await this.pageList(file))
  }

  /** A stored page's image, or null when it is not there. */
  async read(
    path: string,
    mtime: number,
    page: number,
  ): Promise<ArrayBuffer | null> {
    const file = await this.current(path, mtime, false)
    if (!file) return null
    const data = await this.storage.readBinary(pageKey(file, page))
    if (!data) (await this.pageList(file)).delete(page)
    return data
  }

  /** Keeps a page's image, in the background. */
  write(path: string, mtime: number, page: number, data: ArrayBuffer): void {
    void this.enqueue(async () => {
      const file = await this.current(path, mtime, true)
      if (!file) return
      const pages = await this.pageList(file)
      if (pages.has(page)) return
      await this.storage.writeBinary(pageKey(file, page), data)
      pages.add(page)
      file.bytes += data.byteLength
      file.usedAt = Date.now()
      this.dirty.add(file)
      this.markIndex()
      await this.trim(file)
    }).catch((error: unknown) => this.reportError('pdf thumbnail write', error))
  }

  dispose(): void {
    this.disposed = true
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  /**
   * The stored file for this version of `path`: made when `create`, null when
   * there is none or a newer one is stored (the asker read the file before it
   * changed). An older version is removed.
   */
  private async current(
    path: string,
    mtime: number,
    create: boolean,
  ): Promise<StoredFile | null> {
    const files = await this.loadIndex()
    const stored = files.get(path)
    if (stored?.mtime === mtime) return stored
    if (stored && stored.mtime > mtime) return null
    if (stored) this.forget(files, stored)
    if (!create) return null
    const file: StoredFile = {
      path,
      mtime,
      dir: folderName(path, mtime),
      bytes: 0,
      usedAt: Date.now(),
      pages: Promise.resolve(new Set()),
    }
    files.set(path, file)
    this.markIndex()
    return file
  }

  private pageList(file: StoredFile): Promise<Set<number>> {
    const pages =
      file.pages ??
      this.storage
        .readText(`${ROOT}/${file.dir}/${PAGES_FILE}`)
        .then(parsePages)
        .catch((error: unknown) => {
          this.reportError('pdf thumbnail pages', error)
          return new Set<number>()
        })
    file.pages = pages
    return pages
  }

  /** Removes the files used longest ago until the stored total is back
   * under the budget — never `keep`, the one being written. */
  private async trim(keep: StoredFile): Promise<void> {
    const files = await this.loadIndex()
    let total = 0
    for (const file of files.values()) total += file.bytes
    const oldestFirst = [...files.values()]
      .filter((file) => file !== keep)
      .sort((a, b) => a.usedAt - b.usedAt)
    for (const file of oldestFirst) {
      if (total <= this.budgetBytes) break
      total -= file.bytes
      this.forget(files, file)
    }
  }

  private forget(files: Map<string, StoredFile>, file: StoredFile): void {
    files.delete(file.path)
    this.dirty.delete(file)
    this.markIndex()
    void this.enqueue(() => this.storage.remove(`${ROOT}/${file.dir}`)).catch(
      (error: unknown) => this.reportError('pdf thumbnail remove', error),
    )
  }

  private loadIndex(): Promise<Map<string, StoredFile>> {
    this.files ??= this.readIndex()
    return this.files
  }

  private async readIndex(): Promise<Map<string, StoredFile>> {
    const files = new Map<string, StoredFile>()
    let stored: unknown
    try {
      stored = await this.storage.readJson(INDEX_KEY)
    } catch (error) {
      // Unreadable: start over without it, and leave its folders alone —
      // the next index written makes them strays, removed on a later load.
      this.reportError('pdf thumbnail index', error)
      return files
    }
    for (const [path, record] of Object.entries(indexRecords(stored))) {
      files.set(path, { path, ...record, pages: null })
    }
    // Folders the index does not name: written before an index that never
    // got written (the app closed in between). Looked for when its turn
    // comes, so a folder made by a write queued ahead of it is known.
    void this.enqueue(async () => {
      const known = new Set([...files.values()].map((file) => file.dir))
      const { folders } = await this.storage.listEntries(ROOT)
      for (const folder of folders) {
        const dir = folder.slice(folder.lastIndexOf('/') + 1)
        if (!known.has(dir)) await this.storage.remove(`${ROOT}/${dir}`)
      }
    }).catch((error: unknown) => this.reportError('pdf thumbnail sweep', error))
    return files
  }

  private markIndex(): void {
    this.indexDirty = true
    if (this.flushTimer !== null || this.disposed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.enqueue(() => this.flush()).catch((error: unknown) =>
        this.reportError('pdf thumbnail index', error),
      )
    }, FLUSH_DELAY_MS)
  }

  private async flush(): Promise<void> {
    const files = await this.loadIndex()
    for (const file of [...this.dirty]) {
      this.dirty.delete(file)
      if (files.get(file.path) !== file) continue
      const pages = await this.pageList(file)
      await this.storage.writeText(
        `${ROOT}/${file.dir}/${PAGES_FILE}`,
        [...pages].join(','),
      )
    }
    if (!this.indexDirty) return
    this.indexDirty = false
    const records: Record<string, IndexRecord> = {}
    for (const file of files.values()) {
      records[file.path] = {
        dir: file.dir,
        mtime: file.mtime,
        bytes: file.bytes,
        usedAt: file.usedAt,
      }
    }
    await this.storage.writeJson(INDEX_KEY, { version: 1, files: records })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writes.then(operation, operation)
    this.writes = run.catch(() => undefined)
    return run
  }
}

const pageKey = (file: StoredFile, page: number): string =>
  `${ROOT}/${file.dir}/${page}`

function parsePages(text: string | null): Set<number> {
  const pages = new Set<number>()
  for (const part of text?.split(',') ?? []) {
    const page = Number(part)
    if (Number.isInteger(page) && page > 0) pages.add(page)
  }
  return pages
}

function indexRecords(stored: unknown): Record<string, IndexRecord> {
  if (!isObject(stored) || stored.version !== 1 || !isObject(stored.files)) {
    return {}
  }
  const records: Record<string, IndexRecord> = {}
  for (const [path, value] of Object.entries(stored.files)) {
    if (!isObject(value)) continue
    const { dir, mtime, bytes, usedAt } = value
    if (
      typeof dir !== 'string' ||
      !/^[a-z0-9]+$/.test(dir) ||
      typeof mtime !== 'number' ||
      typeof bytes !== 'number' ||
      typeof usedAt !== 'number'
    ) {
      continue
    }
    records[path] = { dir, mtime, bytes, usedAt }
  }
  return records
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A folder name for a version of a file: a storage key segment must be
 * plain letters and digits, which a vault path is not. cyrb53. */
function folderName(path: string, mtime: number): string {
  const text = `${mtime}\n${path}`
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
