// A picture of part of the board, as an SVG that holds a copy of the board's
// own DOM (`<foreignObject>`): what a board export draws onto a canvas a
// part at a time (./boardExport.ts).
//
// The copy is the board as it is mounted at that moment — the cards, their
// content, the edges — so an export looks the way the board does, in the
// user's theme, with nothing drawn twice. How it is made fit for an SVG
// image is ./domCopy.ts's; what is the export's own is that a PDF page is
// drawn again at the export's resolution (`SnapshotServices.pdfPage`), that
// every image, stylesheet and font goes in whole, and the frame the copy is
// shown in.
//
// Popout safety: everything is built in the document of the board it copies.

import { COPY_CSS, blobToDataUrl, copyDom, imageLike } from './domCopy'

const SVG_NS = 'http://www.w3.org/2000/svg'

// The picture's own scaffolding, styled by SNAPSHOT_CSS below: it exists only
// inside the SVG, so its rules travel with it rather than living in the
// module's stylesheet.
const FRAME_CLASS = 'yolo-whiteboard-export-frame'
const FILL_CLASS = 'yolo-whiteboard-export-fill'
const COPY_CLASS = 'yolo-whiteboard-export-world'

/** Laid over every stylesheet in the copy: no scrollbars to show. */
const SNAPSHOT_CSS = `
.${FRAME_CLASS} { position: relative; overflow: hidden; }
.${FILL_CLASS} { position: absolute; inset: 0; background: none !important; overflow: visible; }
.${COPY_CLASS} { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
* { scrollbar-width: none !important; }
*::-webkit-scrollbar { display: none !important; }
${COPY_CSS}`

export type WorldRect = Readonly<{ x: number; y: number; w: number; h: number }>

export type SnapshotServices = Readonly<{
  /** The PDF a card shows: a PDF card's file, or a spread sheet's. */
  pdfFileOf(nodeId: string): string | null
  /** A page of `file` drawn `cssWidth` CSS pixels wide at `pixelRatio`
   * device pixels each, as a data URL; null when it cannot be drawn. */
  pdfPage(
    file: string,
    page: number,
    cssWidth: number,
    pixelRatio: number,
  ): Promise<string | null>
  /** Where a live element is in world units. */
  worldRectOf(el: Element): WorldRect
  /** Elements of the board left out of the picture: those an export of the
   * selection does not include. */
  excluded(): Iterable<Element>
}>

export class BoardSnapshotter {
  private styles: string | null = null
  private readonly resources = new Map<string, Promise<string | null>>()

  constructor(
    private readonly rootEl: HTMLElement,
    private readonly worldEl: HTMLElement,
    private readonly services: SnapshotServices,
  ) {}

  /** The board's background colour, which the picture is drawn on. */
  background(): string {
    const win = this.rootEl.ownerDocument.defaultView
    return win?.getComputedStyle(this.rootEl).backgroundColor ?? '#ffffff'
  }

  /**
   * The SVG of `rect`, `pixelWidth` by `pixelHeight` pixels, with the copy
   * of the board's DOM at `pixelRatio` pixels per world unit. The board must
   * have everything in `rect` mounted and built.
   */
  async tile(
    rect: WorldRect,
    pixelWidth: number,
    pixelHeight: number,
    pixelRatio: number,
  ): Promise<string> {
    const doc = this.rootEl.ownerDocument
    const styles = await this.collectStyles()
    const { copy, finish } = copyDom(this.worldEl, {
      excluded: this.services.excluded(),
      image: (src) => this.resource(src),
      pdfPage: (live) => {
        const card = live.closest<HTMLElement>('[data-node-id]')
        const nodeId = card?.dataset.nodeId ?? null
        const page = Number(live.dataset.page)
        const where = this.services.worldRectOf(live)
        return (pageCopy) =>
          this.redrawPage(pageCopy, nodeId, page, where, rect, pixelRatio)
      },
    })
    await finish()
    // The world without the camera: the tile's corner at the picture's.
    copy.removeAttribute('style')
    copy.classList.add(COPY_CLASS)
    copy.setCssProps({ transform: `translate(${-rect.x}px, ${-rect.y}px)` })

    const win = doc.defaultView
    const computed = win?.getComputedStyle(this.worldEl)
    // The theme's variables, read where the board resolved them: the copy
    // sits under no `body` and no `.app-container` to inherit them from.
    const props: Record<string, string> = {}
    if (computed) {
      for (let i = 0; i < computed.length; i += 1) {
        const name = computed[i]
        if (name.startsWith('--')) props[name] = computed.getPropertyValue(name)
      }
    }
    const bodyStyle = win?.getComputedStyle(doc.body)
    const frame = doc.createElement('div')
    frame.className = `${doc.body.className} ${FRAME_CLASS}`
    frame.setCssProps({
      ...props,
      width: `${rect.w}px`,
      height: `${rect.h}px`,
      background: this.background(),
      'font-family': bodyStyle?.fontFamily ?? 'sans-serif',
      'font-size': bodyStyle?.fontSize ?? '16px',
      'line-height': bodyStyle?.lineHeight ?? 'normal',
      color: bodyStyle?.color ?? '#000',
    })
    const style = doc.createElement('style')
    style.textContent = styles
    const root = doc.createElement('div')
    root.className = `${this.rootEl.className} ${FILL_CLASS}`
    const viewport = doc.createElement('div')
    viewport.className = `yolo-whiteboard-viewport ${FILL_CLASS}`
    viewport.appendChild(copy)
    root.appendChild(viewport)
    frame.append(style, root)

    const svg = doc.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('width', String(pixelWidth))
    svg.setAttribute('height', String(pixelHeight))
    svg.setAttribute('viewBox', `0 0 ${rect.w} ${rect.h}`)
    const object = doc.createElementNS(SVG_NS, 'foreignObject')
    object.setAttribute('width', String(rect.w))
    object.setAttribute('height', String(rect.h))
    object.appendChild(frame)
    svg.appendChild(object)
    return new XMLSerializer().serializeToString(svg)
  }

  /** A PDF page's canvases replaced by one picture of the page at the
   * export's resolution — or by nothing, for a page outside the tile, whose
   * picture would be drawn for no one. */
  private async redrawPage(
    pageEl: HTMLElement,
    nodeId: string | null,
    page: number,
    where: WorldRect,
    tile: WorldRect,
    pixelRatio: number,
  ): Promise<void> {
    const canvases = Array.from(pageEl.querySelectorAll('canvas'))
    const first = canvases[0]
    if (!first) return
    const outside =
      where.x >= tile.x + tile.w ||
      where.x + where.w <= tile.x ||
      where.y >= tile.y + tile.h ||
      where.y + where.h <= tile.y
    const file =
      outside || nodeId === null ? null : this.services.pdfFileOf(nodeId)
    const data =
      file === null
        ? null
        : await this.services.pdfPage(file, page, where.w, pixelRatio)
    for (const canvas of canvases.slice(1)) canvas.remove()
    if (data === null) {
      first.remove()
      return
    }
    first.replaceWith(imageLike(first, data))
  }

  /** Every stylesheet in the document, the board's own included, with the
   * fonts in use inlined. Read once per export. */
  private async collectStyles(): Promise<string> {
    if (this.styles !== null) return this.styles
    const doc = this.rootEl.ownerDocument
    const families = new Set<string>()
    doc.fonts.forEach((face) => {
      if (face.status === 'loaded') families.add(unquote(face.family))
    })
    const parts: Promise<string>[] = []
    for (const sheet of Array.from(doc.styleSheets)) {
      let rules: CSSRuleList
      try {
        rules = sheet.cssRules
      } catch {
        continue
      }
      const base = sheet.href ?? doc.baseURI
      for (const rule of Array.from(rules)) {
        if (!rule.cssText.startsWith('@font-face')) {
          parts.push(Promise.resolve(rule.cssText))
          continue
        }
        const face = rule as CSSFontFaceRule
        if (
          !families.has(unquote(face.style.getPropertyValue('font-family')))
        ) {
          continue
        }
        parts.push(this.inlineUrls(face.cssText, base))
      }
    }
    this.styles = `${(await Promise.all(parts)).join('\n')}\n${SNAPSHOT_CSS}`
    return this.styles
  }

  private async inlineUrls(css: string, base: string): Promise<string> {
    const urls = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)]
    let out = css
    for (const match of urls) {
      const url = match[2]
      if (url.startsWith('data:')) continue
      let absolute: string
      try {
        absolute = new URL(url, base).href
      } catch {
        continue
      }
      const data = await this.resource(absolute)
      if (data) out = out.split(match[0]).join(`url("${data}")`)
    }
    return out
  }

  /** A resource the board loaded, as a data URL. Asked once per export for
   * each address. */
  private resource(src: string): Promise<string | null> {
    let pending = this.resources.get(src)
    if (!pending) {
      const win = this.rootEl.ownerDocument.defaultView
      pending = (async () => {
        try {
          // Not `requestUrl`: what is fetched is the board's own resources —
          // `app://` files and stylesheet fonts the renderer already loaded —
          // and the Host API offers modules no network surface to ask instead.
          // eslint-disable-next-line no-restricted-globals -- local resources the page already loaded, see above
          const response = await fetch(src)
          if (!response.ok) return null
          return await blobToDataUrl(await response.blob(), win)
        } catch {
          return null
        }
      })()
      this.resources.set(src, pending)
    }
    return pending
  }
}

function unquote(family: string): string {
  return family.trim().replace(/^(['"])(.*)\1$/, '$2')
}
