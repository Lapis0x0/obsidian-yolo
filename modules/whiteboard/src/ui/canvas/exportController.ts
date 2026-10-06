// The board's side of exporting a picture of it (../export/boardExport.ts):
// what is exported, the menu that offers it, and what the export needs from
// the board while it walks across it.
//
// What is exported is the selection — carried the way a drag carries it, so
// a group brings what it holds and a spread its every sheet — or the whole
// board when nothing is selected. The menu lists each way of exporting with
// the size of the picture it makes, so how large a file is about to be is
// known before it is asked for; nothing is scaled down to fit anything. The
// picture is saved where the user chooses in the system's save dialog, which
// only a desktop has: there the menu is offered, elsewhere it is not.
//
// `WhiteboardCanvas` builds this and is its only importer.

import { cameraFromView } from '../../domain/camera'
import {
  type ExportRect,
  exportPixelSize,
  exportRegion,
  fitsOneCanvas,
} from '../../domain/exportLayout'
import type { Camera, NodeId } from '../../domain/fileFormat'
import { nodesToDragWith } from '../../domain/groups'
import { basenameWithoutExtension } from '../../domain/naming'
import {
  type BoardExportDeps,
  ExportCancelled,
  type ExportFormat,
  writeBoardPicture,
} from '../export/boardExport'
import type { SnapshotServices, WorldRect } from '../export/boardSnapshot'

import type { CameraController } from './cameraController'
import type { CanvasCore } from './core'
import type { EdgeLayer } from './edgeLayer'
import { isPdfNode } from './pdfIntegration'

/** The resolutions a PNG is offered at, in pixels per world unit. */
const PNG_RATIOS = [1, 2, 4] as const
/** A PDF's: a page printed at twice a screen's density reads sharp. */
const PDF_RATIO = 2
/** The clipboard's, which holds one image whole. */
const COPY_RATIO = 2
/** PDF pages drawn for an export, kept for the next part that shows them. */
const PAGE_CACHE_SIZE = 32

export type ExportScope = 'board' | 'selection'

export type ExportControllerDeps = Readonly<{
  core: CanvasCore
  rootEl: HTMLElement
  viewportEl: HTMLElement
  worldEl: HTMLElement
  camera: Pick<CameraController, 'view' | 'loadCamera'>
  edges: Pick<EdgeLayer, 'elementsOf'>
  /** Whether the board has nothing left to mount or build since the camera
   * last moved. */
  isSettled: () => boolean
  /** The camera was just moved for the export: a settled board is one that
   * has caught up with this. */
  cameraMoved: () => void
  commitEdit: () => void
}>

type Scope = Readonly<{
  region: ExportRect
  /** What the picture includes, or null for everything. */
  ids: ReadonlySet<NodeId> | null
}>

export class ExportController {
  private running = false
  /** Where the pointer last pressed the board, which is where a menu opened
   * from another menu belongs. */
  private lastPress: { x: number; y: number } | null = null

  constructor(private readonly deps: ExportControllerDeps) {
    deps.rootEl.addEventListener(
      'pointerdown',
      (e) => {
        this.lastPress = { x: e.clientX, y: e.clientY }
      },
      true,
    )
  }

  /** The item that opens the export menu, or null where there is no way to
   * save a file or nothing to export. */
  menuItem(scope: ExportScope): YoloModuleHostMenuItemV1 | null {
    if (!this.deps.core.host.ui.canSaveFile()) return null
    if (this.scopeOf(scope) === null) return null
    return {
      title: this.deps.core.t(
        scope === 'selection' ? 'menu.exportSelection' : 'menu.exportBoard',
      ),
      icon: 'image-down',
      onSelect: () => this.showMenu(scope),
    }
  }

  /**
   * Opens the export menu: where the pointer last pressed the board, or —
   * asked from outside it, by a command or the tab's menu — under the board's
   * top-right corner, where the tab's own menu is.
   */
  showMenu(scope: ExportScope, at: 'pointer' | 'corner' = 'pointer'): void {
    const { core, viewportEl } = this.deps
    if (!core.host.ui.canSaveFile()) return
    const target = this.scopeOf(scope)
    if (!target) {
      core.host.ui.notice(core.t('notice.exportNothing'))
      return
    }
    const win = viewportEl.ownerDocument.defaultView
    if (!win) return
    const box = viewportEl.getBoundingClientRect()
    const point =
      at === 'pointer' && this.lastPress
        ? this.lastPress
        : { x: box.right - 16, y: box.top + 8 }
    const event = new win.MouseEvent('contextmenu', {
      clientX: point.x,
      clientY: point.y,
    })
    core.host.ui.showMenu(event, this.menuItems(scope, target))
  }

  private menuItems(
    scope: ExportScope,
    target: Scope,
  ): YoloModuleHostMenuItemV1[] {
    const t = this.deps.core.t
    const label = (key: string, ratio: number): string => {
      const { width, height } = exportPixelSize(target.region, ratio)
      return t(key)
        .replace('{scale}', String(ratio))
        .replace('{width}', String(width))
        .replace('{height}', String(height))
    }
    const items: YoloModuleHostMenuItemV1[] = PNG_RATIOS.map((ratio) => ({
      title: label('export.png', ratio),
      icon: 'file-image',
      onSelect: () => this.exportToFile(scope, 'png', ratio),
    }))
    items.push({
      title: label('export.pdf', PDF_RATIO),
      icon: 'file-text',
      onSelect: () => this.exportToFile(scope, 'pdf', PDF_RATIO),
    })
    items.push({ kind: 'separator' })
    const copyable = fitsOneCanvas(exportPixelSize(target.region, COPY_RATIO))
    items.push({
      title: label(
        copyable ? 'export.copy' : 'export.copyTooLarge',
        COPY_RATIO,
      ),
      icon: 'copy',
      disabled: !copyable,
      onSelect: () => this.copyToClipboard(scope),
    })
    return items
  }

  /** What an export of `scope` covers now, or null for nothing. */
  private scopeOf(scope: ExportScope): Scope | null {
    const board = this.deps.core.getBoard()
    const selected = this.deps.core.getSelectedIds()
    const ids =
      scope === 'selection' && selected.size > 0
        ? new Set(nodesToDragWith(selected, board.nodes))
        : null
    const nodes = ids ? board.nodes.filter((n) => ids.has(n.id)) : board.nodes
    const region = exportRegion(nodes)
    return region ? { region, ids } : null
  }

  private async exportToFile(
    scope: ExportScope,
    format: ExportFormat,
    ratio: number,
  ): Promise<void> {
    const { core } = this.deps
    if (this.running) return
    const target = this.scopeOf(scope)
    if (!target) return
    const name = basenameWithoutExtension(core.getSourcePath()) || 'whiteboard'
    const file = await core.host.ui.saveFile({
      suggestedName: `${name}.${format}`,
      filters: [
        {
          name: core.t(
            format === 'png' ? 'export.pngFilter' : 'export.pdfFilter',
          ),
          extensions: [format],
        },
      ],
    })
    if (!file) return
    try {
      await this.run(target, ratio, format, (chunk) => file.write(chunk))
      await file.close()
      core.host.ui.notice(
        core.t('notice.exported').replace('{name}', file.name),
      )
    } catch (error) {
      await file.abort().catch(() => undefined)
      this.reportFailure(error)
    }
  }

  private async copyToClipboard(scope: ExportScope): Promise<void> {
    const { core, rootEl } = this.deps
    if (this.running) return
    const target = this.scopeOf(scope)
    if (!target) return
    const parts: Uint8Array[] = []
    try {
      await this.run(target, COPY_RATIO, 'png', async (chunk) => {
        parts.push(chunk.slice())
      })
      const win = rootEl.ownerDocument.defaultView
      if (!win) return
      const blob = new win.Blob(parts, { type: 'image/png' })
      await win.navigator.clipboard.write([
        new win.ClipboardItem({ 'image/png': blob }),
      ])
      core.host.ui.notice(core.t('notice.copiedImage'))
    } catch (error) {
      this.reportFailure(error)
    }
  }

  private reportFailure(error: unknown): void {
    const { core } = this.deps
    if (error instanceof ExportCancelled) {
      core.host.ui.notice(core.t('notice.exportCancelled'))
      return
    }
    core.reportError('export', error)
    core.host.ui.notice(core.t('error.exportFailed'))
  }

  /** Walks the board for the picture and hands its bytes to `sink`, with
   * the camera put back where it was however it ends. */
  private async run(
    target: Scope,
    ratio: number,
    format: ExportFormat,
    sink: (chunk: Uint8Array) => Promise<void>,
  ): Promise<void> {
    const { core, camera } = this.deps
    this.running = true
    this.deps.commitEdit()
    const home: Camera = cameraFromView(camera.view)
    const pages = new PdfPages(core.host)
    try {
      await writeBoardPicture(
        this.exportDeps(target, pages),
        { region: target.region, pixelRatio: ratio },
        format,
        sink,
      )
    } finally {
      pages.release()
      camera.loadCamera(home)
      this.running = false
    }
  }

  private exportDeps(target: Scope, pages: PdfPages): BoardExportDeps {
    const { core, rootEl, viewportEl, worldEl, camera, edges } = this.deps
    const services: SnapshotServices = {
      pdfFileOf: (nodeId) => {
        const node = core.getNode(nodeId)
        if (!node) return null
        if (node.type === 'pdf-page') return node.file
        return isPdfNode(node) ? node.file : null
      },
      pdfPage: (file, page, cssWidth, pixelRatio) =>
        pages.draw(rootEl.ownerDocument, file, page, cssWidth, pixelRatio),
      worldRectOf: (el) => worldRectOf(el, viewportEl, camera.view),
      excluded: () => excludedElements(target.ids, core, edges),
    }
    return {
      rootEl,
      viewportEl,
      worldEl,
      snapshot: services,
      moveCamera: (x, y) => {
        camera.loadCamera({ x: -x, y: -y, scale: 1 })
        this.deps.cameraMoved()
      },
      isSettled: this.deps.isSettled,
      text: {
        title: core.t('export.title'),
        cancel: core.t('export.cancel'),
        progress: (done, total) =>
          core
            .t('export.progress')
            .replace('{done}', String(done))
            .replace('{total}', String(total)),
      },
    }
  }
}

/** What a live element covers on the board, from where it is on screen. */
function worldRectOf(
  el: Element,
  viewportEl: HTMLElement,
  view: Readonly<{ tx: number; ty: number; scale: number }>,
): WorldRect {
  const box = el.getBoundingClientRect()
  const origin = viewportEl.getBoundingClientRect()
  return {
    x: (box.left - origin.left - view.tx) / view.scale,
    y: (box.top - origin.top - view.ty) / view.scale,
    w: box.width / view.scale,
    h: box.height / view.scale,
  }
}

/** The mounted elements of everything an export of `ids` leaves out: the
 * cards not in it, and the edges that do not join two cards in it. */
function* excludedElements(
  ids: ReadonlySet<NodeId> | null,
  core: CanvasCore,
  edges: Pick<EdgeLayer, 'elementsOf'>,
): Iterable<Element> {
  if (ids === null) return
  const board = core.getBoard()
  for (const node of board.nodes) {
    if (ids.has(node.id)) continue
    const el = core.getRuntime(node.id)?.el
    if (el) yield el
  }
  for (const edge of board.edges) {
    if (ids.has(edge.fromNode) && ids.has(edge.toNode)) continue
    yield* edges.elementsOf(edge.id)
  }
}

/** The PDFs an export draws pages of: each opened once for the export, and
 * the pages it drew kept for the next part that shows them. */
class PdfPages {
  private readonly documents = new Map<
    string,
    Promise<YoloModuleHostPdfDocumentV1 | null>
  >()
  private readonly pictures = new Map<string, Promise<string | null>>()

  constructor(private readonly host: YoloModuleHostApiV1) {}

  draw(
    doc: Document,
    file: string,
    pageNumber: number,
    cssWidth: number,
    pixelRatio: number,
  ): Promise<string | null> {
    const key = `${file}\n${pageNumber}\n${cssWidth.toFixed(2)}\n${pixelRatio}`
    const cached = this.pictures.get(key)
    if (cached) {
      // Most recently used last, so the oldest is the one let go.
      this.pictures.delete(key)
      this.pictures.set(key, cached)
      return cached
    }
    const picture = this.render(doc, file, pageNumber, cssWidth, pixelRatio)
    this.pictures.set(key, picture)
    if (this.pictures.size > PAGE_CACHE_SIZE) {
      const oldest = this.pictures.keys().next().value
      if (oldest !== undefined) this.pictures.delete(oldest)
    }
    return picture
  }

  private async render(
    doc: Document,
    file: string,
    pageNumber: number,
    cssWidth: number,
    pixelRatio: number,
  ): Promise<string | null> {
    let opened = this.documents.get(file)
    if (!opened) {
      opened = this.host.pdf.open(file).catch(() => null)
      this.documents.set(file, opened)
    }
    const pdf = await opened
    if (!pdf || pageNumber < 1 || pageNumber > pdf.pageCount) return null
    try {
      const page = await pdf.getPage(pageNumber)
      const canvas = doc.createElement('canvas')
      await page.render({
        canvas,
        scale: cssWidth / page.width,
        pixelRatio,
      }).promise
      const data = canvas.toDataURL('image/png')
      // Its pixels are in the data URL now; the canvas's are let go at once
      // rather than whenever it is collected.
      canvas.width = 0
      canvas.height = 0
      return data
    } catch {
      return null
    }
  }

  release(): void {
    for (const opened of this.documents.values()) {
      void opened.then((pdf) => pdf?.release())
    }
    this.documents.clear()
    this.pictures.clear()
  }
}
