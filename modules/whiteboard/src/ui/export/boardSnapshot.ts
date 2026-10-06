// A picture of part of the board, as an SVG that holds a copy of the board's
// own DOM (`<foreignObject>`): what a board export draws onto a canvas a
// part at a time (./boardExport.ts).
//
// The copy is the board as it is mounted at that moment — the cards, their
// content, the edges — so an export looks the way the board does, in the
// user's theme, with nothing drawn twice. What an SVG image cannot hold is
// put right on the way:
//
// - chrome is taken out: the resize handles and connection points, snap
//   guides, the spread frame, a PDF's page controls, and the classes that
//   mark a card selected, hovered or being dragged;
// - what lives outside the DOM is brought in: a PDF page's canvas is drawn
//   again at the export's resolution (`SnapshotServices.pdfPage`), any other
//   canvas and a video's current frame become images, and every image,
//   stylesheet font and resource is inlined, since an SVG image loads
//   nothing of its own;
// - an embedded web page cannot be copied at all, and stands as its address;
// - an element scrolled within its card keeps its scroll, which a copy
//   would otherwise lose.
//
// Popout safety: everything is built in the document of the board it copies.

const SVG_NS = 'http://www.w3.org/2000/svg'
const TAG = 'data-yolo-export'

/** Taken out of the copy: chrome, which says something about the pointer
 * or the selection rather than about the board. */
const CHROME_SELECTORS = [
  '.yolo-whiteboard-interaction-layer',
  '.yolo-whiteboard-passage-handles',
  '.yolo-whiteboard-passage-points',
  '.yolo-whiteboard-snap-guides',
  '.yolo-whiteboard-spread-frame',
  '.yolo-whiteboard-edge-preview',
  '.yolo-whiteboard-edge-hit',
  '.yolo-whiteboard-create-ghost',
  '.yolo-whiteboard-landing-slot',
  '.yolo-whiteboard-card-stream-stop',
  '.yolo-whiteboard-card-parked',
  '.yolo-whiteboard-card-pooled',
  '.yolo-whiteboard-card-exiting',
  '.yolo-whiteboard-pdf-text',
  '.yolo-whiteboard-pdf-text-probe',
  '.yolo-whiteboard-pdf-indicator',
  '.yolo-whiteboard-pdf-search-open',
  '.yolo-whiteboard-pdf-area-toggle',
  '.yolo-whiteboard-pdf-area-draft',
  '.yolo-whiteboard-pdf-flash',
].join(',')

/** Stripped from the copy: state the pointer or the selection put there. */
const STATE_CLASSES = [
  'yolo-whiteboard-card-selected',
  'yolo-whiteboard-card-focused',
  'yolo-whiteboard-card-hovered',
  'yolo-whiteboard-card-dragging',
  'yolo-whiteboard-edge-selected',
  'yolo-whiteboard-edge-hovered',
  'yolo-whiteboard-spread-sheet-of-selected',
  'yolo-whiteboard-pdf-canvas-fade-in',
]

const PDF_PAGE_SELECTOR = '.yolo-whiteboard-pdf-page[data-page]'

// The picture's own scaffolding, styled by SNAPSHOT_CSS below: it exists only
// inside the SVG, so its rules travel with it rather than living in the
// module's stylesheet.
const FRAME_CLASS = 'yolo-whiteboard-export-frame'
const FILL_CLASS = 'yolo-whiteboard-export-fill'
const COPY_CLASS = 'yolo-whiteboard-export-world'
const SCROLLED_CLASS = 'yolo-whiteboard-export-scrolled'
const STAND_IN_CLASS = 'yolo-whiteboard-export-stand-in'
const IMAGE_CLASS = 'yolo-whiteboard-export-image'

/** Laid over every stylesheet in the copy: a still picture has no motion to
 * be caught halfway through, and no scrollbars to show. */
const SNAPSHOT_CSS = `
.${FRAME_CLASS} { position: relative; overflow: hidden; }
.${FILL_CLASS} { position: absolute; inset: 0; background: none !important; overflow: visible; }
.${COPY_CLASS} { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.${SCROLLED_CLASS} { overflow: hidden !important; }
.${STAND_IN_CLASS} { display: flex; align-items: center; justify-content: center; padding: var(--size-4-4); color: var(--text-muted); font-size: var(--font-ui-small); word-break: break-all; text-align: center; }
img.${IMAGE_CLASS} { width: 100%; height: 100%; }
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
* { scrollbar-width: none !important; }
*::-webkit-scrollbar { display: none !important; }
`

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

type Tagged =
  | { kind: 'scroll'; top: number; left: number }
  | { kind: 'canvas'; el: HTMLCanvasElement }
  | { kind: 'pdf-page'; nodeId: string | null; page: number; rect: WorldRect }
  | { kind: 'image'; src: string }
  | { kind: 'video'; el: HTMLVideoElement }
  | { kind: 'frame'; src: string }
  | { kind: 'drop' }

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
    const tagged = this.tagLive()
    let copy: HTMLElement
    try {
      copy = this.worldEl.cloneNode(true) as HTMLElement
    } finally {
      for (const el of Array.from(this.worldEl.querySelectorAll(`[${TAG}]`))) {
        el.removeAttribute(TAG)
      }
    }
    for (const el of Array.from(copy.querySelectorAll(CHROME_SELECTORS))) {
      el.remove()
    }
    for (const cls of STATE_CLASSES) {
      for (const el of Array.from(copy.querySelectorAll(`.${cls}`))) {
        el.classList.remove(cls)
      }
    }
    await this.resolveTagged(copy, tagged, rect, pixelRatio)
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

  /**
   * Marks the live elements the copy needs something from — read before
   * copying, since a copy keeps no scroll offset, no canvas picture and no
   * video frame — and returns what each needs, by mark.
   */
  private tagLive(): Map<string, Tagged> {
    const tagged = new Map<string, Tagged>()
    let next = 0
    const tag = (el: Element, value: Tagged): void => {
      const id = String(next++)
      el.setAttribute(TAG, id)
      tagged.set(id, value)
    }
    for (const el of this.services.excluded()) tag(el, { kind: 'drop' })
    const walker = this.worldEl.ownerDocument.createTreeWalker(
      this.worldEl,
      NodeFilter.SHOW_ELEMENT,
    )
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node as HTMLElement
      if (el.hasAttribute(TAG)) continue
      if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
        tag(el, { kind: 'scroll', top: el.scrollTop, left: el.scrollLeft })
        continue
      }
      if (el.matches(PDF_PAGE_SELECTOR) && el.querySelector('canvas')) {
        const card = el.closest<HTMLElement>('[data-node-id]')
        tag(el, {
          kind: 'pdf-page',
          nodeId: card?.dataset.nodeId ?? null,
          page: Number(el.dataset.page),
          rect: this.services.worldRectOf(el),
        })
        continue
      }
      if (el.tagName === 'CANVAS') {
        if (!el.closest(PDF_PAGE_SELECTOR)) {
          tag(el, { kind: 'canvas', el: el as HTMLCanvasElement })
        }
      } else if (el.tagName === 'IMG') {
        const src =
          (el as HTMLImageElement).currentSrc || el.getAttribute('src')
        if (src && !src.startsWith('data:')) tag(el, { kind: 'image', src })
      } else if (el.tagName === 'VIDEO') {
        tag(el, { kind: 'video', el: el as HTMLVideoElement })
      } else if (el.tagName === 'IFRAME') {
        tag(el, { kind: 'frame', src: (el as HTMLIFrameElement).src })
      }
    }
    return tagged
  }

  private async resolveTagged(
    copy: HTMLElement,
    tagged: ReadonlyMap<string, Tagged>,
    tile: WorldRect,
    pixelRatio: number,
  ): Promise<void> {
    const doc = copy.ownerDocument
    const work: Promise<void>[] = []
    for (const el of Array.from(
      copy.querySelectorAll<HTMLElement>(`[${TAG}]`),
    )) {
      const what = tagged.get(el.getAttribute(TAG) ?? '')
      el.removeAttribute(TAG)
      if (!what) continue
      switch (what.kind) {
        case 'drop':
          el.remove()
          break
        case 'scroll':
          keepScroll(el, what.top, what.left)
          break
        case 'canvas':
          el.replaceWith(imageLike(el, canvasPicture(what.el)))
          break
        case 'video':
          el.replaceWith(imageLike(el, videoFrame(what.el)))
          break
        case 'frame': {
          const stand = doc.createElement('div')
          stand.className = `${el.className} ${STAND_IN_CLASS}`
          stand.textContent = what.src
          el.replaceWith(stand)
          break
        }
        case 'image':
          work.push(
            this.resource(what.src).then((data) => {
              el.removeAttribute('srcset')
              el.removeAttribute('loading')
              if (data) el.setAttribute('src', data)
              else el.removeAttribute('src')
            }),
          )
          break
        case 'pdf-page':
          work.push(this.redrawPage(el, what, tile, pixelRatio))
          break
      }
    }
    await Promise.all(work)
  }

  /** A PDF page's canvases replaced by one picture of the page at the
   * export's resolution — or by nothing, for a page outside the tile, whose
   * picture would be drawn for no one. */
  private async redrawPage(
    pageEl: HTMLElement,
    what: Extract<Tagged, { kind: 'pdf-page' }>,
    tile: WorldRect,
    pixelRatio: number,
  ): Promise<void> {
    const canvases = Array.from(pageEl.querySelectorAll('canvas'))
    const first = canvases[0]
    if (!first) return
    const outside =
      what.rect.x >= tile.x + tile.w ||
      what.rect.x + what.rect.w <= tile.x ||
      what.rect.y >= tile.y + tile.h ||
      what.rect.y + what.rect.h <= tile.y
    const file =
      outside || what.nodeId === null
        ? null
        : this.services.pdfFileOf(what.nodeId)
    const data =
      file === null
        ? null
        : await this.services.pdfPage(file, what.page, what.rect.w, pixelRatio)
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

/** Keeps a copied element's scroll: an SVG image cannot be scrolled, so its
 * content is moved instead. A lone child is moved itself; several are
 * gathered into one so they move together. */
function keepScroll(el: HTMLElement, top: number, left: number): void {
  el.classList.add(SCROLLED_CLASS)
  const shift = `translate(${-left}px, ${-top}px)`
  const children = Array.from(el.children) as HTMLElement[]
  if (children.length === 1) {
    const child = children[0]
    const own = child.style.transform
    child.setCssProps({ transform: own ? `${shift} ${own}` : shift })
    return
  }
  const holder = el.ownerDocument.createElement('div')
  holder.setCssProps({ transform: shift })
  holder.append(...Array.from(el.childNodes))
  el.appendChild(holder)
}

/** An image standing where `el` stood, at its size and with its classes, so
 * the board's styles — a dark theme's filter on a PDF page included — apply
 * to it as they did to the element. */
function imageLike(el: Element, src: string | null): HTMLElement {
  const doc = el.ownerDocument
  const live = el as HTMLElement
  if (src === null) return doc.createElement('span')
  const img = doc.createElement('img')
  // Its classes, for the styles that apply to it; its own inline size, when
  // it has one, ahead of filling what holds it.
  img.className = `${live.className} ${IMAGE_CLASS}`
  img.style.cssText = live.style.cssText
  img.setAttribute('src', src)
  return img
}

function canvasPicture(canvas: HTMLCanvasElement): string | null {
  if (canvas.width === 0 || canvas.height === 0) return null
  try {
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

function videoFrame(video: HTMLVideoElement): string | null {
  if (video.readyState < 2 || video.videoWidth === 0) {
    return video.poster || null
  }
  const canvas = video.ownerDocument.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  canvas.getContext('2d')?.drawImage(video, 0, 0)
  return canvasPicture(canvas)
}

function blobToDataUrl(
  blob: Blob,
  win: (Window & typeof globalThis) | null,
): Promise<string | null> {
  const Reader = win?.FileReader ?? FileReader
  return new Promise((resolve) => {
    const reader = new Reader()
    reader.onload = () =>
      resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}
