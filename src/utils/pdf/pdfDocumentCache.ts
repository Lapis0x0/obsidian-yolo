import type {
  PdfEngineDocument,
  PdfEnginePage,
  RuntimeComponentLease,
} from '../../core/runtime-components/contracts'

export type PdfDocumentHandle = Readonly<{
  path: string
  pageCount: number
  getPage(pageNumber: number): Promise<PdfEnginePage>
  isStale(): boolean
  /** Fires once, when the document becomes stale. */
  subscribe(listener: () => void): () => void
  release(): void
}>

export type PdfDocumentCacheOptions = Readonly<{
  readFile(path: string): Promise<Uint8Array>
  acquireEngine(): Promise<RuntimeComponentLease<'pdf-engine'>>
  reportError?(error: unknown): void
}>

type Opened = Readonly<{
  document: PdfEngineDocument
  lease: RuntimeComponentLease<'pdf-engine'>
}>

type Entry = {
  readonly path: string
  readonly opened: Promise<Opened>
  refs: number
  stale: boolean
  closed: boolean
  readonly listeners: Set<() => void>
  destroyed: Promise<void> | null
}

/** Opens raced by a concurrent file change retry this many times. */
const MAX_OPEN_ATTEMPTS = 3

/**
 * Long-lived pdf-engine documents keyed by vault path, shared by everyone who
 * opens the same unchanged file and destroyed when the last handle goes.
 *
 * Each open document holds its own lease on the engine, so the component
 * stays loaded exactly while a document is open. A file change
 * (`invalidate`) retires the path's document: it stops being handed out,
 * its handles are told they are stale, and it lives on until they release
 * it. `closeAll` is the engine being turned off: every document is destroyed
 * at once, whoever still holds it.
 */
export class PdfDocumentCache {
  private readonly current = new Map<string, Entry>()
  private readonly live = new Set<Entry>()

  constructor(private readonly options: PdfDocumentCacheOptions) {}

  async open(path: string): Promise<PdfDocumentHandle> {
    for (let attempt = 1; ; attempt += 1) {
      const entry = this.current.get(path) ?? this.createEntry(path)
      entry.refs += 1
      let opened: Opened
      try {
        opened = await entry.opened
      } catch (error) {
        entry.refs -= 1
        throw error
      }
      if (entry.closed) {
        this.unref(entry)
        throw new Error('PDF engine was turned off')
      }
      if (!entry.stale || attempt >= MAX_OPEN_ATTEMPTS) {
        return this.createHandle(entry, opened.document)
      }
      this.unref(entry)
    }
  }

  /** The file at `path` changed, moved or went away. */
  invalidate(path: string): void {
    const entry = this.current.get(path)
    if (entry) this.retire(entry)
  }

  /** Destroys every document now; their handles become stale and inert. */
  async closeAll(): Promise<void> {
    const entries = [...this.live]
    for (const entry of entries) {
      entry.closed = true
      this.retire(entry)
    }
    await Promise.allSettled(entries.map((entry) => this.destroy(entry)))
  }

  private createEntry(path: string): Entry {
    const entry: Entry = {
      path,
      opened: this.load(path),
      refs: 0,
      stale: false,
      closed: false,
      listeners: new Set(),
      destroyed: null,
    }
    this.current.set(path, entry)
    this.live.add(entry)
    entry.opened.catch(() => {
      if (this.current.get(path) === entry) this.current.delete(path)
      this.live.delete(entry)
    })
    return entry
  }

  private async load(path: string): Promise<Opened> {
    const lease = await this.options.acquireEngine()
    try {
      const bytes = await this.options.readFile(path)
      const document = await lease.api.openDocument(bytes)
      return { document, lease }
    } catch (error) {
      lease.release()
      throw error
    }
  }

  private createHandle(
    entry: Entry,
    document: PdfEngineDocument,
  ): PdfDocumentHandle {
    let released = false
    const own = new Set<() => void>()
    const assertOpen = (): void => {
      if (released) throw new Error('PDF document handle is released')
      if (entry.closed) throw new Error('PDF engine was turned off')
    }
    return Object.freeze({
      path: entry.path,
      pageCount: document.pageCount,
      getPage: async (pageNumber: number) => {
        assertOpen()
        return document.getPage(pageNumber)
      },
      isStale: () => entry.stale,
      subscribe: (listener: () => void) => {
        if (typeof listener !== 'function') {
          throw new TypeError('PDF document listener must be a function')
        }
        assertOpen()
        const wrapped = () => listener()
        own.add(wrapped)
        if (entry.stale) {
          // Staleness is a one-way state, so a late subscriber still hears
          // about it rather than waiting for an event that already happened.
          queueMicrotask(() => {
            if (own.delete(wrapped)) this.notify(wrapped)
          })
        } else {
          entry.listeners.add(wrapped)
        }
        return () => {
          own.delete(wrapped)
          entry.listeners.delete(wrapped)
        }
      },
      release: () => {
        if (released) return
        released = true
        for (const listener of own) entry.listeners.delete(listener)
        own.clear()
        this.unref(entry)
      },
    })
  }

  private retire(entry: Entry): void {
    if (this.current.get(entry.path) === entry) this.current.delete(entry.path)
    if (entry.stale) return
    entry.stale = true
    const listeners = [...entry.listeners]
    entry.listeners.clear()
    for (const listener of listeners) this.notify(listener)
  }

  private notify(listener: () => void): void {
    try {
      listener()
    } catch (error) {
      this.options.reportError?.(error)
    }
  }

  private unref(entry: Entry): void {
    entry.refs -= 1
    if (entry.refs > 0) return
    if (this.current.get(entry.path) === entry) this.current.delete(entry.path)
    this.destroy(entry).catch((error: unknown) => {
      this.options.reportError?.(error)
    })
  }

  private destroy(entry: Entry): Promise<void> {
    entry.destroyed ??= entry.opened.then(
      async ({ document, lease }) => {
        try {
          await document.destroy()
        } finally {
          lease.release()
          this.live.delete(entry)
        }
      },
      () => undefined,
    )
    return entry.destroyed
  }
}
