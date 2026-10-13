// The pictures a board makes of what it shows (ui/pictures/) — a PDF's pages,
// an image file, a card — kept on this device, so that a board opened again —
// on another board, after a restart — shows them at once instead of making
// every one anew.
//
// Device-local private storage (an IndexedDB database of this vault): a
// picture is made from something and can always be made again, so it has no
// business syncing. One store per kind of picture, each under its own root and
// with its own budget, so that one kind never crowds out another.
//
// Pictures are kept in groups. A group is what is made, used and let go of as
// a whole — a version of a PDF (its pages), a version of an image file, a
// board (its cards) — and has a folder of its own: a file per picture, and the
// list of them, with each picture's size, what it was made from (`stamp`) and
// whatever its maker keeps beside it (`meta`). An index names the folders with
// their size and when they were last used; past the budget, the groups used
// longest ago go first, whole — a spread is opened as a whole, and half its
// pages would be worth little.
//
// A group's version is a number its maker chooses: a file's modification
// time, or a constant for a group that is never replaced as a whole (a
// board's cards, each of which says by its stamp whether it is still right).
// Renaming a file, or a sync that only touches its time, costs its pictures
// being made again; telling files apart by their contents would cost reading
// every one before a stored picture could be shown, which is what this is
// here to avoid.

import { hashText } from '../domain/hash'

type PrivateScope = YoloModuleHostApiV1['privateStorage']['deviceLocal']

const INDEX_FILE = 'index.json'
const ENTRIES_FILE = 'entries.json'
/** Raised whenever what is written changes shape: the folders of another
 * version are let go of whole, never read. */
const INDEX_VERSION = 3
/** About 20 000 PDF pages, or as many cards. */
const BUDGET_BYTES = 200 * 1024 * 1024
/** How long after a change the lists and the index are written: a spread's
 * pages come in one after another, and each write is read back. */
const FLUSH_DELAY_MS = 1500

/** A kept picture, as its maker described it when it was made. */
export type StoredPicture = Readonly<{
  /** Its size in pixels, as made. */
  width: number
  height: number
  /** What it was made from, in its maker's words: a picture asked for with
   * another stamp is not this one. */
  stamp: string
  /** Whatever its maker keeps beside it — a PDF page's geometry. */
  meta: unknown
}>

type EntryRecord = StoredPicture & Readonly<{ bytes: number }>

type EntryList = Map<string, EntryRecord>

type StoredGroup = {
  readonly group: string
  readonly version: number
  readonly dir: string
  bytes: number
  usedAt: number
  /** The pictures in the folder, read when first asked for. */
  entries: Promise<EntryList> | null
}

type IndexRecord = Readonly<{
  dir: string
  version: number
  bytes: number
  usedAt: number
}>

const EMPTY: ReadonlyMap<string, StoredPicture> = new Map()

export class PictureStore {
  private groups: Promise<Map<string, StoredGroup>> | null = null
  /** Every write to storage, one after another, so a folder is never
   * removed under a picture being written into it. */
  private writes: Promise<unknown> = Promise.resolve()
  /** Groups whose list has changed since it was written. */
  private readonly dirty = new Set<StoredGroup>()
  private indexDirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly storage: PrivateScope,
    /** Where this kind of picture is kept: a storage key of its own. */
    private readonly root: string,
    /** What its errors are reported as. */
    private readonly label: string,
    private readonly reportError: (stage: string, error: unknown) => void,
    /** Only tests set this: filling the real budget costs 200 MB. */
    private readonly budgetBytes = BUDGET_BYTES,
  ) {}

  /** The pictures stored of this version of `group`, by key. An older
   * version of it is let go of here. */
  async entries(
    group: string,
    version: number,
  ): Promise<ReadonlyMap<string, StoredPicture>> {
    const stored = await this.current(group, version, false)
    if (!stored) return EMPTY
    stored.usedAt = Date.now()
    this.markIndex()
    const pictures = new Map<string, StoredPicture>()
    for (const [key, { width, height, stamp, meta }] of await this.entryList(
      stored,
    )) {
      pictures.set(key, { width, height, stamp, meta })
    }
    return pictures
  }

  /** A stored picture's image, or null when it is not there. */
  async read(
    group: string,
    version: number,
    key: string,
  ): Promise<ArrayBuffer | null> {
    const stored = await this.current(group, version, false)
    if (!stored) return null
    const data = await this.storage.readBinary(this.entryKey(stored, key))
    if (!data) (await this.entryList(stored)).delete(key)
    return data
  }

  /** Keeps a picture, in place of any kept under its key, in the
   * background. */
  write(
    group: string,
    version: number,
    key: string,
    data: ArrayBuffer,
    picture: StoredPicture,
  ): void {
    void this.enqueue(async () => {
      const stored = await this.current(group, version, true)
      if (!stored) return
      const entries = await this.entryList(stored)
      const previous = entries.get(key)
      await this.storage.writeBinary(this.entryKey(stored, key), data)
      entries.set(key, {
        width: picture.width,
        height: picture.height,
        stamp: picture.stamp,
        meta: picture.meta,
        bytes: data.byteLength,
      })
      stored.bytes += data.byteLength - (previous?.bytes ?? 0)
      stored.usedAt = Date.now()
      this.dirty.add(stored)
      this.markIndex()
      await this.trim(stored)
    }).catch((error: unknown) => this.reportError(`${this.label} write`, error))
  }

  /** Lets go of every picture of this version of `group` but those under
   * `keys` — the cards a board no longer has. */
  keep(group: string, version: number, keys: ReadonlySet<string>): void {
    void this.enqueue(async () => {
      const stored = await this.current(group, version, false)
      if (!stored) return
      const entries = await this.entryList(stored)
      let removed = false
      for (const [key, entry] of [...entries]) {
        if (keys.has(key)) continue
        entries.delete(key)
        stored.bytes -= entry.bytes
        removed = true
        await this.storage.removeFile(this.entryKey(stored, key))
      }
      if (!removed) return
      this.dirty.add(stored)
      this.markIndex()
    }).catch((error: unknown) => this.reportError(`${this.label} keep`, error))
  }

  dispose(): void {
    this.disposed = true
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  /**
   * The stored group for this version of `group`: made when `create`, null
   * when there is none or a newer one is stored (the asker read its source
   * before it changed). An older version is removed.
   */
  private async current(
    group: string,
    version: number,
    create: boolean,
  ): Promise<StoredGroup | null> {
    const groups = await this.loadIndex()
    const stored = groups.get(group)
    if (stored?.version === version) return stored
    if (stored && stored.version > version) return null
    if (stored) this.forget(groups, stored)
    if (!create) return null
    const made: StoredGroup = {
      group,
      version,
      // A storage key segment must be plain letters and digits, which a
      // vault path is not.
      dir: hashText(`${version}\n${group}`),
      bytes: 0,
      usedAt: Date.now(),
      entries: Promise.resolve(new Map()),
    }
    groups.set(group, made)
    this.markIndex()
    return made
  }

  private entryList(stored: StoredGroup): Promise<EntryList> {
    const entries =
      stored.entries ??
      this.readList(`${this.root}/${stored.dir}/${ENTRIES_FILE}`)
        .then(parseEntries)
        .catch((error: unknown) => {
          this.reportError(`${this.label} entries`, error)
          return new Map<string, EntryRecord>()
        })
    stored.entries = entries
    return entries
  }

  private entryKey(stored: StoredGroup, key: string): string {
    return `${this.root}/${stored.dir}/${hashText(key)}`
  }

  /** Removes the groups used longest ago until the stored total is back
   * under the budget — never `keep`, the one being written. */
  private async trim(keep: StoredGroup): Promise<void> {
    const groups = await this.loadIndex()
    let total = 0
    for (const stored of groups.values()) total += stored.bytes
    const oldestFirst = [...groups.values()]
      .filter((stored) => stored !== keep)
      .sort((a, b) => a.usedAt - b.usedAt)
    for (const stored of oldestFirst) {
      if (total <= this.budgetBytes) break
      total -= stored.bytes
      this.forget(groups, stored)
    }
  }

  private forget(groups: Map<string, StoredGroup>, stored: StoredGroup): void {
    groups.delete(stored.group)
    this.dirty.delete(stored)
    this.markIndex()
    void this.enqueue(() =>
      this.storage.remove(`${this.root}/${stored.dir}`),
    ).catch((error: unknown) => this.reportError(`${this.label} remove`, error))
  }

  private loadIndex(): Promise<Map<string, StoredGroup>> {
    this.groups ??= this.readIndex()
    return this.groups
  }

  private async readIndex(): Promise<Map<string, StoredGroup>> {
    const groups = new Map<string, StoredGroup>()
    let stored: unknown
    try {
      stored = await this.readList(`${this.root}/${INDEX_FILE}`)
    } catch (error) {
      // Unreadable: start over without it, and leave its folders alone —
      // the next index written makes them strays, removed on a later load.
      this.reportError(`${this.label} index`, error)
      return groups
    }
    for (const [group, record] of Object.entries(indexRecords(stored))) {
      groups.set(group, { group, ...record, entries: null })
    }
    // Folders the index does not name: written before an index that never
    // got written (the app closed in between), or by another version of
    // this store. Looked for when its turn comes, so a folder made by a
    // write queued ahead of it is known.
    void this.enqueue(async () => {
      const known = new Set([...groups.values()].map((group) => group.dir))
      const { folders } = await this.storage.listEntries(this.root)
      for (const folder of folders) {
        const dir = folder.slice(folder.lastIndexOf('/') + 1)
        if (!known.has(dir)) await this.storage.remove(`${this.root}/${dir}`)
      }
    }).catch((error: unknown) => this.reportError(`${this.label} sweep`, error))
    return groups
  }

  private markIndex(): void {
    this.indexDirty = true
    if (this.flushTimer !== null || this.disposed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.enqueue(() => this.flush()).catch((error: unknown) =>
        this.reportError(`${this.label} index`, error),
      )
    }, FLUSH_DELAY_MS)
  }

  private async flush(): Promise<void> {
    const groups = await this.loadIndex()
    for (const stored of [...this.dirty]) {
      this.dirty.delete(stored)
      if (groups.get(stored.group) !== stored) continue
      const entries = await this.entryList(stored)
      await this.writeList(
        `${this.root}/${stored.dir}/${ENTRIES_FILE}`,
        Object.fromEntries(entries),
      )
    }
    if (!this.indexDirty) return
    this.indexDirty = false
    const records: Record<string, IndexRecord> = {}
    for (const stored of groups.values()) {
      records[stored.group] = {
        dir: stored.dir,
        version: stored.version,
        bytes: stored.bytes,
        usedAt: stored.usedAt,
      }
    }
    await this.writeList(`${this.root}/${INDEX_FILE}`, {
      version: INDEX_VERSION,
      groups: records,
    })
  }

  /**
   * The store's own lists, kept as text it serializes itself. Private
   * storage's JSON calls refuse a document of more than ten thousand values,
   * and a list of pictures is not a document someone wrote: a board of 1,700
   * cards is past it, and every picture after that was made, kept and never
   * listed — made again on each open. What that limit guards against is not
   * here; the size limit on what is written still is.
   */
  private async readList(key: string): Promise<unknown> {
    const text = await this.storage.readText(key)
    return text === null ? null : (JSON.parse(text) as unknown)
  }

  private writeList(key: string, value: unknown): Promise<void> {
    return this.storage.writeText(key, JSON.stringify(value))
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writes.then(operation, operation)
    this.writes = run.catch(() => undefined)
    return run
  }
}

function parseEntries(stored: unknown): EntryList {
  const entries: EntryList = new Map()
  if (!isObject(stored)) return entries
  for (const [key, value] of Object.entries(stored)) {
    if (!isObject(value)) continue
    const { width, height, stamp, meta, bytes } = value
    if (
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      typeof stamp !== 'string' ||
      typeof bytes !== 'number'
    ) {
      continue
    }
    entries.set(key, { width, height, stamp, meta: meta ?? null, bytes })
  }
  return entries
}

function indexRecords(stored: unknown): Record<string, IndexRecord> {
  // Another version's index, and so its folders, are let go of whole: they
  // are swept as strays.
  if (
    !isObject(stored) ||
    stored.version !== INDEX_VERSION ||
    !isObject(stored.groups)
  ) {
    return {}
  }
  const records: Record<string, IndexRecord> = {}
  for (const [group, value] of Object.entries(stored.groups)) {
    if (!isObject(value)) continue
    const { dir, version, bytes, usedAt } = value
    if (
      typeof dir !== 'string' ||
      !/^[a-z0-9]+$/.test(dir) ||
      typeof version !== 'number' ||
      typeof bytes !== 'number' ||
      typeof usedAt !== 'number'
    ) {
      continue
    }
    records[group] = { dir, version, bytes, usedAt }
  }
  return records
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The stores a board keeps its pictures in, one per kind of picture. */
export type PictureStores = Readonly<{
  pdf: PictureStore
  image: PictureStore
  card: PictureStore
}>
