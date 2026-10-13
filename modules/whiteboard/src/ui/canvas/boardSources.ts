// Where the board a canvas works on comes from, and where what is done to it
// goes.
//
// The canvas works on one board (`composition.board`): its own file's, with
// what is behind each open portal put on it (domain/portals.ts). Each file
// is a document shared with every other view of it (host/boardDocuments.ts).
// This keeps the documents the board was made from, decides which portals
// are open (the canvas says which it wants — `wantsOpen`), makes the board
// again whenever one of them changes, and sends each edit back to the files
// it touched.

import type { Board, FileNode, NodeId } from '../../domain/fileFormat'
import {
  type BoardChanges,
  type Composition,
  applyChanges,
  changesBetween,
  composeBoard,
} from '../../domain/portals'
import { collapseBoard } from '../../domain/spread'
import type {
  BoardDocument,
  BoardDocumentOwner,
  BoardDocuments,
} from '../../host/boardDocuments'

export type BoardSourcesDeps = Readonly<{
  documents: BoardDocuments
  /** The file this canvas is open on. */
  ownPath: () => string
  /** Whether a portal should be open now — on screen, and large enough to
   * show anything. `open` is whether it is now. */
  wantsOpen: (portal: FileNode, id: NodeId, open: boolean) => boolean
  /** A document this board is made from was changed by something else, or
   * finished loading: the board should be made again. */
  onSourceChange: (ownFile: boolean) => void
  owner: BoardDocumentOwner
}>

/** Why a portal shows nothing behind it. */
export type PortalState =
  | 'open'
  | 'closed'
  | 'loading'
  | 'missing'
  | 'invalid'
  | 'cycle'

export class BoardSources {
  private own: BoardDocument | null = null
  private disown: (() => void) | null = null
  private unsubscribeOwn: (() => void) | null = null
  /** Documents behind portals, by file, held while this canvas lives. */
  private readonly behind = new Map<
    string,
    { document: BoardDocument; unsubscribe: () => void }
  >()
  private compositionValue: Composition = {
    board: {
      version: 1,
      camera: { x: 0, y: 0, scale: 1 },
      nodes: [],
      edges: [],
      extra: {},
    },
    portals: new Map(),
  }
  /** Portals open on the board last made, by their id there. */
  private open = new Set<NodeId>()
  /** Why each portal on the board last made shows what it shows. */
  private readonly states = new Map<NodeId, PortalState>()

  constructor(private readonly deps: BoardSourcesDeps) {}

  get composition(): Composition {
    return this.compositionValue
  }

  /** The own file's board, as its document has it. */
  get ownBoard(): Board | null {
    return this.own?.board ?? null
  }

  get ownDocument(): BoardDocument | null {
    return this.own
  }

  /** Whether a portal on the board is waiting for its board to be read. */
  get loading(): boolean {
    for (const state of this.states.values()) {
      if (state === 'loading') return true
    }
    return false
  }

  portalState(id: NodeId): PortalState {
    return this.states.get(id) ?? 'closed'
  }

  /** The document behind a portal onto `file`, if one is held. */
  documentBehind(file: string): BoardDocument | null {
    return this.behind.get(file)?.document ?? null
  }

  /**
   * The own file, as its view read it: becomes the document's board. Null
   * when it does not parse.
   */
  load(text: string): Board | null {
    const path = this.deps.ownPath()
    if (this.own?.path !== path) this.releaseOwn()
    if (!this.own) {
      this.own = this.deps.documents.acquire(path)
      this.disown = this.own.own(this.deps.owner)
      this.unsubscribeOwn = this.own.subscribe((origin) => {
        if (origin !== this) this.deps.onSourceChange(true)
      })
    }
    return this.own.loadText(text, this)
  }

  /** Makes the board again from the documents, opening the portals the
   * canvas wants open. */
  compose(): Board {
    const own = this.own?.board
    if (!own) return this.compositionValue.board
    this.states.clear()
    const open = new Set<NodeId>()
    const ownPath = this.deps.ownPath()
    // Every board a portal here is onto, open or not: what is worth keeping
    // hold of.
    const pointedAt = new Set<string>()
    this.compositionValue = composeBoard(
      own,
      ownPath,
      (portal, id, ancestors) => {
        pointedAt.add(portal.file)
        if (ancestors.includes(portal.file)) {
          this.states.set(id, 'cycle')
          return null
        }
        if (!this.deps.wantsOpen(portal, id, this.open.has(id))) {
          this.states.set(id, 'closed')
          return null
        }
        const document = this.hold(portal.file)
        if (document.status !== 'ready' || !document.board) {
          this.states.set(
            id,
            document.status === 'ready' ? 'missing' : document.status,
          )
          return null
        }
        this.states.set(id, 'open')
        open.add(id)
        return document.board
      },
    )
    // The states of portals the board itself has (the own file's, closed
    // or open) were set above; a portal no `expand` was asked about is
    // behind one that is shut.
    this.open = open
    for (const [file, held] of this.behind) {
      if (pointedAt.has(file)) continue
      held.unsubscribe()
      this.deps.documents.release(held.document)
      this.behind.delete(file)
    }
    return this.compositionValue.board
  }

  /** Whether making the board again would open or shut a portal. */
  wouldChange(portals: readonly FileNode[]): boolean {
    for (const portal of portals) {
      const isOpen = this.open.has(portal.id)
      const cycle = this.states.get(portal.id) === 'cycle'
      if (cycle) continue
      const wants = this.deps.wantsOpen(portal, portal.id, isOpen)
      if (!wants) {
        if (isOpen) return true
        continue
      }
      if (isOpen) continue
      const document = this.behind.get(portal.file)?.document
      // Not yet asked for: asking opens it once it is read.
      if (!document) return true
      if (document.status === 'ready' && document.board) return true
    }
    return false
  }

  /**
   * Sends what going from the board last made to `next` changed to the
   * files it changed, and returns it.
   */
  commit(next: Board): BoardChanges {
    const changes = changesBetween(
      this.compositionValue,
      next,
      this.deps.ownPath(),
    )
    this.apply(changes)
    return changes
  }

  /** Puts `changes` on the files they are of. */
  apply(changes: BoardChanges): void {
    const ownPath = this.deps.ownPath()
    for (const [file, fileChanges] of changes) {
      const document = file === ownPath ? this.own : this.hold(file)
      document?.apply(fileChanges, this)
    }
  }

  /** The own file as it would be with `board`'s changes — what saving it
   * writes, without changing anything. */
  ownBoardWith(board: Board): Board | null {
    const own = this.own?.board
    if (!own) return null
    if (board === this.compositionValue.board) return own
    const changes = changesBetween(
      this.compositionValue,
      board,
      this.deps.ownPath(),
    )
    const ownChanges = changes.get(this.deps.ownPath())
    return ownChanges ? applyChanges(own, ownChanges) : own
  }

  /** What saving the own file writes. */
  ownFileBoard(board: Board): Board | null {
    const own = this.ownBoardWith(board)
    return own ? collapseBoard(own) : null
  }

  dispose(): void {
    this.releaseOwn()
    for (const { document, unsubscribe } of this.behind.values()) {
      unsubscribe()
      this.deps.documents.release(document)
    }
    this.behind.clear()
  }

  private hold(file: string): BoardDocument {
    const held = this.behind.get(file)
    if (held) return held.document
    const document = this.deps.documents.acquire(file)
    const unsubscribe = document.subscribe((origin) => {
      if (origin !== this) this.deps.onSourceChange(false)
    })
    this.behind.set(file, { document, unsubscribe })
    return document
  }

  private releaseOwn(): void {
    this.unsubscribeOwn?.()
    this.unsubscribeOwn = null
    this.disown?.()
    this.disown = null
    if (this.own) this.deps.documents.release(this.own)
    this.own = null
  }
}
