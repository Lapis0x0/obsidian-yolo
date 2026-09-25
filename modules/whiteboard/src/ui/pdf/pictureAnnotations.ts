// The annotations of every PDF whose pages a board shows as pictures
// (./thumbnails.ts) — what the overview draws over them, as a reader draws
// a page's annotations over its picture.
//
// Held from the module's shared stores (../../host/annotationStore.ts), the
// same ones every reader edits, so a highlight made anywhere is drawn over
// the pictures the moment it is made, before its file is written.

import type { PdfAnnotation } from '../../domain/pdfAnnotations'
import type {
  AnnotationLease,
  AnnotationStores,
} from '../../host/annotationStore'

type Held = Readonly<{ lease: AnnotationLease; unsubscribe: () => void }>

export class PictureAnnotations {
  private readonly held = new Map<string, Held>()

  constructor(
    private readonly stores: AnnotationStores,
    /** A held PDF's annotations changed. */
    private readonly onChange: () => void,
  ) {}

  /** Holds the annotations of the PDFs at `paths`, and lets go of the
   * rest. Called whenever the board changes. */
  retain(paths: ReadonlySet<string>): void {
    for (const [path, held] of [...this.held]) {
      if (paths.has(path)) continue
      this.held.delete(path)
      this.letGo(held)
    }
    for (const path of paths) {
      if (this.held.has(path)) continue
      const lease = this.stores.acquire(path)
      const unsubscribe = lease.store.subscribe(this.onChange)
      this.held.set(path, { lease, unsubscribe })
    }
  }

  forPage(path: string, page: number): readonly PdfAnnotation[] {
    return this.held.get(path)?.lease.store.forPage(page) ?? []
  }

  destroy(): void {
    for (const held of this.held.values()) this.letGo(held)
    this.held.clear()
  }

  private letGo(held: Held): void {
    held.unsubscribe()
    held.lease.release()
  }
}
