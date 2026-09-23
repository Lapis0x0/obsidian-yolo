// The annotations of one PDF, shared by everything showing that PDF, and the
// file they live in (../domain/pdfAnnotations.ts).
//
// One `AnnotationStore` per PDF path at a time, handed out by the module's
// `AnnotationStores` and counted: every reader over the PDF — its card, the
// view's reading panel, the same PDF on another open board — holds the same
// store and repaints from the same change, so a highlight made in one is in
// all of them at once. The last reader to let go writes what is pending and
// the store goes.
//
// The file is read and written whole. Changes are written once they have
// paused for WRITE_DELAY_MS, and at once when the store is let go. A change
// to the file from anywhere else (sync, another device, a hand edit) is read
// back in and replaces what is shown; our own writes come back as modify
// events too, and are recognized by their content — the text we last wrote
// — rather than by timing, which a slow disk or a sync client would fool.
//
// A file this version cannot read — a later version's, or one that is not an
// annotation file — is never written: what could be read of it is shown, and
// editing is refused rather than allowed to overwrite it.
//
// The PDF's file lifecycle is followed here too, for open and closed PDFs
// alike, since a PDF can be renamed or deleted while no board shows it:
//   - rename or move: the annotation file is renamed with it, and a live
//     store keeps working under the new path (a board that follows the
//     rename to the new path gets the same store back);
//   - delete: the annotation file goes to the trash with it — the user's
//     trash, by the user's deletion setting, so restoring the PDF from the
//     trash can restore its annotations beside it. Keeping it instead would
//     leave an invisible file (Obsidian's explorer hides .json by default)
//     describing a PDF that is gone, and silently attach it to any unrelated
//     PDF later saved under that name.

import {
  type PdfAnnotation,
  annotationFilePath,
  isAnnotationFilePath,
  parseAnnotationFile,
  serializeAnnotationFile,
} from '../domain/pdfAnnotations'

type Host = YoloModuleHostApiV1
type ReportError = (stage: string, error: unknown) => void
type VaultEvent = Parameters<Parameters<Host['vault']['subscribe']>[1]>[0]

/** How long edits have to pause before the file is written. */
const WRITE_DELAY_MS = 600
/** Undo steps kept per PDF. */
const HISTORY_LIMIT = 100
/** `host.paths.runExclusive` namespace for following a PDF's renames and
 * deletes, so two landing close together cannot interleave. */
const FOLLOW_NAMESPACE = 'whiteboard-pdf-annotations'

export type AnnotationPatch = Readonly<{
  color?: string
  /** An empty string removes the comment. */
  comment?: string
}>

export class AnnotationStore {
  private pdfPathValue: string
  private list: readonly PdfAnnotation[] = []
  private preserved: readonly unknown[] = []
  private byPage = new Map<number, readonly PdfAnnotation[]>()
  private readonly listeners = new Set<() => void>()
  private loaded = false
  /** The file could not be read as one this version may write. */
  private locked = false
  /** The PDF was deleted: nothing more is written. */
  private closed = false
  /** What we last wrote, or read: an event bringing exactly this back is our
   * own write returning, not news. */
  private lastText: string | null = null
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  private past: (readonly PdfAnnotation[])[] = []
  private future: (readonly PdfAnnotation[])[] = []
  /** Bumped by every reload, so a slow read cannot land over a newer one. */
  private loadGeneration = 0

  constructor(
    private readonly host: Host,
    pdfPath: string,
    private readonly reportError: ReportError,
  ) {
    this.pdfPathValue = pdfPath
    void this.load()
  }

  get pdfPath(): string {
    return this.pdfPathValue
  }

  get filePath(): string {
    return annotationFilePath(this.pdfPathValue)
  }

  /** Whether edits are accepted: the file has been read, is one this version
   * may write, and the PDF still exists. */
  get writable(): boolean {
    return this.loaded && !this.locked && !this.closed
  }

  getAll(): readonly PdfAnnotation[] {
    return this.list
  }

  forPage(page: number): readonly PdfAnnotation[] {
    return this.byPage.get(page) ?? []
  }

  get(id: string): PdfAnnotation | undefined {
    return this.list.find((annotation) => annotation.id === id)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  add(annotations: readonly PdfAnnotation[]): boolean {
    if (annotations.length === 0) return false
    return this.commit([...this.list, ...annotations])
  }

  update(id: string, patch: AnnotationPatch): boolean {
    const now = new Date().toISOString()
    let changed = false
    const next = this.list.map((annotation) => {
      if (annotation.id !== id) return annotation
      const updated: Record<string, unknown> = { ...annotation }
      if (patch.color !== undefined && patch.color !== annotation.color) {
        updated.color = patch.color
        changed = true
      }
      if (patch.comment !== undefined) {
        const comment = patch.comment.trim()
        if (comment === '' && annotation.comment !== undefined) {
          delete updated.comment
          changed = true
        } else if (comment !== '' && comment !== annotation.comment) {
          updated.comment = comment
          changed = true
        }
      }
      if (!changed) return annotation
      updated.updatedAt = now
      return updated as PdfAnnotation
    })
    return changed && this.commit(next)
  }

  remove(id: string): boolean {
    const next = this.list.filter((annotation) => annotation.id !== id)
    return next.length !== this.list.length && this.commit(next)
  }

  canUndo(): boolean {
    return this.writable && this.past.length > 0
  }

  canRedo(): boolean {
    return this.writable && this.future.length > 0
  }

  undo(): boolean {
    const previous = this.past[this.past.length - 1]
    if (!this.writable || !previous) return false
    this.past.pop()
    this.future.push(this.list)
    this.apply(previous)
    this.scheduleWrite()
    return true
  }

  redo(): boolean {
    const next = this.future[this.future.length - 1]
    if (!this.writable || !next) return false
    this.future.pop()
    this.past.push(this.list)
    this.apply(next)
    this.scheduleWrite()
    return true
  }

  // -----------------------------------------------------------------------
  // For AnnotationStores
  // -----------------------------------------------------------------------

  /** Writes what is pending now. */
  flush(): Promise<void> {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
      this.writing = this.writing.then(() => this.write())
    }
    return this.writing
  }

  /** The PDF was renamed; the file has been (or is being) renamed with it. */
  retarget(pdfPath: string): void {
    this.pdfPathValue = pdfPath
  }

  /** The PDF is gone. */
  close(): void {
    this.closed = true
    if (this.writeTimer !== null) clearTimeout(this.writeTimer)
    this.writeTimer = null
    this.past = []
    this.future = []
    this.apply([])
  }

  /** The annotation file changed on disk (or appeared, or went). */
  onFileEvent(type: 'create' | 'modify' | 'delete'): void {
    if (type === 'delete') {
      if (this.lastText === null) return
      this.lastText = null
      this.resetFromDisk([], [], false)
      return
    }
    void this.load()
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private commit(next: readonly PdfAnnotation[]): boolean {
    if (!this.writable) return false
    this.past.push(this.list)
    if (this.past.length > HISTORY_LIMIT) this.past.shift()
    this.future = []
    this.apply(next)
    this.scheduleWrite()
    return true
  }

  private apply(next: readonly PdfAnnotation[]): void {
    this.list = next
    const byPage = new Map<number, PdfAnnotation[]>()
    for (const annotation of next) {
      const page = annotation.anchor.page
      const list = byPage.get(page)
      if (list) list.push(annotation)
      else byPage.set(page, [annotation])
    }
    this.byPage = byPage
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        this.reportError('annotation listener', error)
      }
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== null) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.writing = this.writing.then(() => this.write())
    }, WRITE_DELAY_MS)
  }

  private async write(): Promise<void> {
    if (!this.writable) return
    const path = this.filePath
    const text = serializeAnnotationFile(this.list, this.preserved)
    if (text === this.lastText) return
    const exists = this.host.vault.getEntry(path) !== null
    // Nothing to keep and nowhere it was kept: no file is created for a PDF
    // whose only highlight was made and undone.
    if (!exists && this.list.length === 0 && this.preserved.length === 0) {
      return
    }
    // Set before the write, whose modify event can arrive before it returns.
    this.lastText = text
    try {
      if (exists) await this.host.vault.writeText(path, text)
      else await this.host.vault.createText(path, text)
    } catch (error) {
      this.lastText = null
      this.reportError('annotation write', error)
    }
  }

  private async load(): Promise<void> {
    const generation = ++this.loadGeneration
    const path = this.filePath
    let text: string | null = null
    try {
      if (this.host.vault.getEntry(path) !== null) {
        text = await this.host.vault.readText(path)
      }
    } catch (error) {
      this.reportError('annotation read', error)
      return
    }
    if (generation !== this.loadGeneration || this.closed) return
    if (text !== null && text === this.lastText) {
      this.loaded = true
      return
    }
    // Something else wrote the file: that is now what the PDF's annotations
    // are. An edit of ours still waiting to be written would be a write over
    // it, so it is dropped with the history it belonged to.
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.lastText = text
    if (text === null) {
      this.resetFromDisk([], [], false)
      return
    }
    const parsed = parseAnnotationFile(text)
    if (!parsed.ok) {
      this.reportError(
        'annotation read',
        new Error(
          parsed.reason === 'newer'
            ? `${path} was written by a newer version; it is shown read-only`
            : `${path} is not an annotation file; it is left untouched`,
        ),
      )
      this.resetFromDisk(parsed.annotations, [], true)
      return
    }
    this.resetFromDisk(parsed.annotations, parsed.preserved, false)
  }

  private resetFromDisk(
    annotations: readonly PdfAnnotation[],
    preserved: readonly unknown[],
    locked: boolean,
  ): void {
    this.loaded = true
    this.locked = locked
    this.preserved = preserved
    this.past = []
    this.future = []
    this.apply(annotations)
  }
}

/** A store held by one reader, until it lets go. */
export type AnnotationLease = Readonly<{
  store: AnnotationStore
  release(): void
}>

/**
 * The module's stores, one per PDF with anyone reading it, and the follower
 * that keeps annotation files with their PDFs. One per module activation.
 */
export class AnnotationStores {
  private readonly stores = new Map<
    string,
    { store: AnnotationStore; holders: number }
  >()
  private readonly unsubscribe: () => void

  constructor(
    private readonly host: Host,
    private readonly reportError: ReportError,
  ) {
    this.unsubscribe = host.vault.subscribe('', (event) =>
      this.onVaultEvent(event),
    )
  }

  acquire(pdfPath: string): AnnotationLease {
    let entry = this.stores.get(pdfPath)
    if (!entry) {
      entry = {
        store: new AnnotationStore(this.host, pdfPath, this.reportError),
        holders: 0,
      }
      this.stores.set(pdfPath, entry)
    }
    entry.holders += 1
    const held = entry
    let released = false
    return Object.freeze({
      store: held.store,
      release: () => {
        if (released) return
        released = true
        held.holders -= 1
        if (held.holders > 0) return
        // Keyed by where the store is now, which a rename may have moved.
        if (this.stores.get(held.store.pdfPath) === held) {
          this.stores.delete(held.store.pdfPath)
        }
        void held.store.flush()
      },
    })
  }

  dispose(): void {
    this.unsubscribe()
    for (const { store } of this.stores.values()) void store.flush()
    this.stores.clear()
  }

  private onVaultEvent(event: VaultEvent): void {
    if (event.entry.kind !== 'file') return
    const path = event.entry.path
    if (isAnnotationFilePath(path)) {
      // A file renamed onto a store's path is that store's file appearing: a
      // board that followed its PDF's rename can have asked for the new path
      // before the file was moved there.
      const type = event.type === 'rename' ? 'create' : event.type
      for (const { store } of this.stores.values()) {
        if (store.filePath === path) store.onFileEvent(type)
      }
      return
    }
    if (!isPdfPath(event.type === 'rename' ? event.oldPath : path)) return
    if (event.type === 'rename') {
      const oldPath = event.oldPath
      void this.host.paths
        .runExclusive(FOLLOW_NAMESPACE, () => this.followRename(oldPath, path))
        .catch((error: unknown) => this.reportError('annotation rename', error))
    } else if (event.type === 'delete') {
      void this.host.paths
        .runExclusive(FOLLOW_NAMESPACE, () => this.followDelete(path))
        .catch((error: unknown) => this.reportError('annotation delete', error))
    }
  }

  private async followRename(oldPath: string, newPath: string): Promise<void> {
    const entry = this.stores.get(oldPath)
    // What is pending goes to the old file first, so it moves with it.
    if (entry) await entry.store.flush()
    const from = annotationFilePath(oldPath)
    const to = annotationFilePath(newPath)
    // Absent when a folder was moved: the file went with its PDF already.
    if (
      this.host.vault.getEntry(from) !== null &&
      this.host.vault.getEntry(to) === null
    ) {
      await this.host.vault.renamePath(from, to)
    }
    if (entry && this.stores.get(oldPath) === entry) {
      this.stores.delete(oldPath)
      entry.store.retarget(newPath)
      if (!this.stores.has(newPath)) this.stores.set(newPath, entry)
    }
  }

  private async followDelete(pdfPath: string): Promise<void> {
    this.stores.get(pdfPath)?.store.close()
    const file = annotationFilePath(pdfPath)
    if (this.host.vault.getEntry(file) !== null) {
      await this.host.vault.trashPath(file)
    }
  }
}

function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith('.pdf')
}
