// Every board file the module has in memory, once.
//
// A board is shown in its own tab, and behind portals on other boards
// (domain/portals.ts) — several at once, and worked on in each. They have to
// be one board: a card moved in one place is moved everywhere it is seen, and
// what is written to the file is all of it. So a file in memory is a
// `BoardDocument` here, shared by everything that shows it, and each change is
// made to it and told to the others.
//
// Who writes the file depends on whether it is open in a tab. When it is, the
// tab's view is its owner (`own`): Obsidian's text file view reads and writes
// it, and tells the view when it changes on disk — so a change made here asks
// the owner to save, and what the owner reads is put here. When it is not,
// the document reads it itself and writes it back a moment after each change,
// over the file only if the file is still what it last read or wrote; if it
// changed meanwhile (a sync, the agent), what it now has is read and the
// changes not yet written are put on it again.
//
// The board kept is the board's shape of the file: an open PDF spread is its
// pages (domain/spread.ts's `expandBoard`), folded back when written.

import { type Board, parseBoard, serializeBoard } from '../domain/fileFormat'
import { type FileChanges, applyChanges, mergeChanges } from '../domain/portals'
import { collapseBoard, expandBoard } from '../domain/spread'

/** How long after a change a document no tab owns waits to write it. */
const WRITE_DELAY_MS = 800

/** The view that has a board open as its own file. */
export type BoardDocumentOwner = Readonly<{
  /** Saves the file, by way of the view (it serializes `board`). */
  requestSave: () => void
}>

export type BoardDocumentStatus = 'loading' | 'ready' | 'missing' | 'invalid'

type Snapshot = Awaited<
  ReturnType<YoloModuleHostApiV1['vault']['readTextSnapshot']>
>

export class BoardDocument {
  private boardValue: Board | null = null
  private statusValue: BoardDocumentStatus = 'loading'
  private revisionValue = 0
  private readonly listeners = new Set<(origin: unknown) => void>()
  private owners: BoardDocumentOwner[] = []
  /** The file as last read or written here, when no tab owns it. */
  private snapshot: Snapshot = null
  /** Changes made since the file was last written here. */
  private unwritten: FileChanges | null = null
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  /** Handles held (`BoardDocuments.acquire`). */
  refs = 0

  constructor(
    private pathValue: string,
    private readonly host: YoloModuleHostApiV1,
    private readonly reportError: (stage: string, error: unknown) => void,
  ) {}

  get path(): string {
    return this.pathValue
  }

  /** The board, once read; null while loading, or when there is none. */
  get board(): Board | null {
    return this.boardValue
  }

  get status(): BoardDocumentStatus {
    return this.statusValue
  }

  /** Bumped by every change: a cheap way to ask whether it changed. */
  get revision(): number {
    return this.revisionValue
  }

  get owned(): boolean {
    return this.owners.length > 0
  }

  /** Runs `listener` after every change, with what made it — so a view can
   * leave alone the changes it made itself. */
  subscribe(listener: (origin: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Puts `changes` on the board, made by `origin`, and has them written. */
  apply(changes: FileChanges, origin: unknown): void {
    if (!this.boardValue) {
      // Not read yet: they go on it once it is (`load`).
      if (this.statusValue === 'loading') {
        this.unwritten = this.unwritten
          ? fileMerge(this.unwritten, changes)
          : changes
      }
      return
    }
    const next = applyChanges(this.boardValue, changes)
    if (next === this.boardValue) return
    this.set(next, origin)
    this.persist(changes)
  }

  /**
   * Makes `owner` the view this file is open in. What the view reads from the
   * file is put here (`loadText`), and what changes here it saves. Returns
   * the release.
   */
  own(owner: BoardDocumentOwner): () => void {
    this.owners.push(owner)
    // Owned: the view writes from now on, what is unwritten included.
    this.cancelWrite()
    if (this.unwritten) owner.requestSave()
    this.unwritten = null
    return () => {
      this.owners = this.owners.filter((known) => known !== owner)
      // What the view had will be read again before anything is written.
      if (this.owners.length === 0) this.snapshot = null
    }
  }

  /** The file as its owner read it: what is in memory is replaced. */
  loadText(text: string, origin: unknown): Board | null {
    const result = parseBoard(text)
    if (!result.ok) {
      this.statusValue = 'invalid'
      this.set(null, origin)
      return null
    }
    const board = expandBoard(result.board)
    this.statusValue = 'ready'
    this.set(board, origin)
    return board
  }

  /** Reads the file, when no tab owns it. */
  async load(): Promise<void> {
    if (this.owned) return
    let snapshot: Snapshot
    try {
      snapshot = await this.host.vault.readTextSnapshot(this.pathValue)
    } catch (error) {
      this.reportError('board read', error)
      snapshot = null
    }
    if (this.owned) return
    if (!snapshot) {
      this.snapshot = null
      this.statusValue = 'missing'
      this.set(null, null)
      return
    }
    if (this.snapshot && snapshot.content === this.snapshot.content) return
    this.snapshot = snapshot
    const result = parseBoard(snapshot.content)
    if (!result.ok) {
      this.statusValue = 'invalid'
      this.set(null, null)
      return
    }
    let board = expandBoard(result.board)
    // Changed under changes not written yet, or read after changes were
    // made to it: they go on what it now is, and are written.
    if (this.unwritten) board = applyChanges(board, this.unwritten)
    this.statusValue = 'ready'
    this.set(board, null)
    if (this.unwritten) this.persist({ nodes: new Map(), edges: new Map() })
  }

  /** The file was renamed: it is the same board. */
  moved(path: string): void {
    this.pathValue = path
    if (this.snapshot) this.snapshot = { ...this.snapshot, path }
    this.revisionValue += 1
    for (const listener of [...this.listeners]) listener(null)
  }

  /** Writes now what is waiting to be written. */
  flush(): Promise<void> {
    if (this.writeTimer === null) return this.writing
    this.cancelWrite()
    return this.write()
  }

  private set(board: Board | null, origin: unknown): void {
    this.boardValue = board
    this.revisionValue += 1
    for (const listener of [...this.listeners]) listener(origin)
  }

  private persist(changes: FileChanges): void {
    const owner = this.owners[0]
    if (owner) {
      owner.requestSave()
      return
    }
    this.unwritten = this.unwritten
      ? fileMerge(this.unwritten, changes)
      : changes
    this.cancelWrite()
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.write()
    }, WRITE_DELAY_MS)
  }

  private cancelWrite(): void {
    if (this.writeTimer !== null) clearTimeout(this.writeTimer)
    this.writeTimer = null
  }

  private write(): Promise<void> {
    this.writing = this.writing.then(async () => {
      if (this.owned || !this.unwritten || !this.boardValue) return
      const content = serializeBoard(collapseBoard(this.boardValue))
      try {
        const expected = this.snapshot
        const written = expected
          ? await this.host.vault.replaceTextIfUnchanged(expected, content)
          : await this.host.vault.createTextIfAbsent(this.pathValue, content)
        if (written) {
          this.snapshot = written
          this.unwritten = null
          return
        }
        // Changed on disk meanwhile: read what it is, put the changes on it,
        // and try again.
        this.snapshot = null
        await this.load()
      } catch (error) {
        this.reportError('board write', error)
      }
    })
    return this.writing
  }
}

function fileMerge(first: FileChanges, then: FileChanges): FileChanges {
  return mergeChanges(new Map([['', first]]), new Map([['', then]])).get(
    '',
  ) as FileChanges
}

export class BoardDocuments {
  private readonly documents = new Map<string, BoardDocument>()
  private readonly unsubscribe: () => void

  constructor(
    private readonly host: YoloModuleHostApiV1,
    private readonly reportError: (stage: string, error: unknown) => void,
  ) {
    this.unsubscribe = host.vault.subscribe('', (event) => {
      if (event.entry.kind !== 'file') return
      if (event.type === 'rename') {
        const document = this.documents.get(event.oldPath)
        if (!document) return
        this.documents.delete(event.oldPath)
        this.documents.set(event.entry.path, document)
        document.moved(event.entry.path)
        return
      }
      const document = this.documents.get(event.entry.path)
      // An owned file hears of its changes through its view.
      if (!document || document.owned) return
      if (event.type === 'modify' || event.type === 'delete') {
        void document.load()
      }
    })
  }

  /** The document of the board at `path`, read if it is not yet; held until
   * `release`.
   *
   * Read once the caller has had the chance to `own` it: a view acquires its
   * own file and owns it in the same step, and the file is then what the view
   * read — reading it here as well would be a second read of the whole board,
   * for nothing (and, for a view not yet given its file, a read of no path). */
  acquire(path: string): BoardDocument {
    let document = this.documents.get(path)
    if (!document) {
      const created = new BoardDocument(path, this.host, this.reportError)
      document = created
      this.documents.set(path, created)
      void Promise.resolve().then(() => created.load())
    }
    document.refs += 1
    return document
  }

  release(document: BoardDocument): void {
    document.refs -= 1
    if (document.refs > 0) return
    void document.flush().then(() => {
      if (document.refs > 0) return
      if (this.documents.get(document.path) === document) {
        this.documents.delete(document.path)
      }
    })
  }

  dispose(): void {
    this.unsubscribe()
    for (const document of this.documents.values()) void document.flush()
  }
}
