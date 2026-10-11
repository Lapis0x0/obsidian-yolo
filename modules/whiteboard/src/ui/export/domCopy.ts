// A copy of part of the board's DOM that an SVG image can show
// (`<foreignObject>`): what a board export draws a part of the board from
// (./boardSnapshot.ts), and what a card's picture of itself is taken from
// (../pictures/cardPictures.ts).
//
// The copy is the board as it is mounted at that moment, so a picture looks
// the way the board does, in the user's theme. What an SVG image cannot hold
// is put right on the way:
//
// - chrome is taken out: the resize handles and connection points, snap
//   guides, the spread frame, a PDF's page controls, and the classes that
//   mark a card selected, hovered or being dragged;
// - what lives outside the DOM is brought in: a PDF page's canvas is drawn
//   again by whoever asks for it (`CopyHooks.pdfPage`), any other canvas and
//   a video's current frame become images, and every image is inlined (how,
//   is the asker's: `CopyHooks.image`), since an SVG image loads nothing of
//   its own;
// - an embedded web page cannot be copied at all, and stands as its address;
// - an element scrolled within its card keeps its scroll, which a copy
//   would otherwise lose.
//
// In two parts (`copyDom`): what has to be read off the live elements and
// can be done at once, and what waits for something to load. A picture taken
// in an idle slice does the first in the slice and awaits the second.
//
// Popout safety: everything is built in the document of the element copied.

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

/** A copied element scrolled within its card: its content is moved
 * instead. */
const SCROLLED_CLASS = 'yolo-whiteboard-export-scrolled'
/** What an embedded page stands as. */
const STAND_IN_CLASS = 'yolo-whiteboard-export-stand-in'
/** An image standing where a canvas or a video stood. */
const IMAGE_CLASS = 'yolo-whiteboard-export-image'

/** The rules the copy's own scaffolding needs, laid over the stylesheet it
 * is shown with: a still picture has no motion to be caught halfway
 * through. How its scrollbars are kept out of sight is the asker's. */
export const COPY_CSS = `
.${SCROLLED_CLASS} { overflow: hidden !important; }
.${STAND_IN_CLASS} { display: flex; align-items: center; justify-content: center; padding: var(--size-4-4); color: var(--text-muted); font-size: var(--font-ui-small); word-break: break-all; text-align: center; }
img.${IMAGE_CLASS} { width: 100%; height: 100%; }
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
`

export type CopyHooks = Readonly<{
  /** Elements left out of the copy. */
  excluded?: Iterable<Element>
  /** False for an element that has never been laid out — built out of
   * sight (../pictures/cardStage.ts): nothing in it is scrolled and its
   * images have no size yet, so its layout is not read, which would lay it
   * out only to be told so. */
  laidOut?: boolean
  /** An image the copy shows from `src`, `width` CSS pixels wide on the
   * board (0 when that is not known), as a data URL; null leaves it
   * empty. */
  image: (src: string, width: number) => Promise<string | null>
  /** How a PDF page is pictured in the copy, decided while its live
   * element is at hand: what to do to the page's copy, or null to leave
   * its canvases as images of what they show. */
  pdfPage?: (live: HTMLElement) => ((copy: HTMLElement) => Promise<void>) | null
}>

type Tagged =
  | { kind: 'scroll'; top: number; left: number }
  | { kind: 'canvas'; el: HTMLCanvasElement }
  | { kind: 'pdf-page'; redraw: (copy: HTMLElement) => Promise<void> }
  | { kind: 'image'; src: string; width: number }
  | { kind: 'video'; el: HTMLVideoElement }
  | { kind: 'frame'; src: string }
  | { kind: 'drop' }

/** A copy, and the work it still waits on: its images, its PDF pages. */
export type PendingCopy = Readonly<{
  copy: HTMLElement
  finish: () => Promise<void>
}>

/**
 * Copies `live` and everything in it: what can be done at once is done, the
 * rest is `finish`. Reads layout off the live elements (scroll offsets, an
 * image's width), so it belongs where layout is clean.
 */
export function copyDom(live: HTMLElement, hooks: CopyHooks): PendingCopy {
  const tagged = tagLive(live, hooks)
  let copy: HTMLElement
  try {
    copy = live.cloneNode(true) as HTMLElement
  } finally {
    for (const el of Array.from(live.querySelectorAll(`[${TAG}]`))) {
      el.removeAttribute(TAG)
    }
    live.removeAttribute(TAG)
  }
  for (const el of Array.from(copy.querySelectorAll(CHROME_SELECTORS))) {
    el.remove()
  }
  for (const cls of STATE_CLASSES) {
    copy.classList.remove(cls)
    for (const el of Array.from(copy.querySelectorAll(`.${cls}`))) {
      el.classList.remove(cls)
    }
  }
  const work: (() => Promise<void>)[] = []
  const doc = copy.ownerDocument
  for (const el of Array.from(copy.querySelectorAll<HTMLElement>(`[${TAG}]`))) {
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
        work.push(() =>
          hooks.image(what.src, what.width).then((data) => {
            el.removeAttribute('srcset')
            el.removeAttribute('loading')
            if (data) el.setAttribute('src', data)
            else el.removeAttribute('src')
          }),
        )
        break
      case 'pdf-page':
        work.push(() => what.redraw(el))
        break
    }
  }
  return {
    copy,
    finish: async () => {
      await Promise.all(work.map((run) => run()))
    },
  }
}

/**
 * Marks the live elements the copy needs something from — read before
 * copying, since a copy keeps no scroll offset, no canvas picture and no
 * video frame — and returns what each needs, by mark.
 */
function tagLive(live: HTMLElement, hooks: CopyHooks): Map<string, Tagged> {
  const tagged = new Map<string, Tagged>()
  let next = 0
  const tag = (el: Element, value: Tagged): void => {
    const id = String(next++)
    el.setAttribute(TAG, id)
    tagged.set(id, value)
  }
  for (const el of hooks.excluded ?? []) tag(el, { kind: 'drop' })
  const laidOut = hooks.laidOut !== false
  const walker = live.ownerDocument.createTreeWalker(
    live,
    NodeFilter.SHOW_ELEMENT,
  )
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as HTMLElement
    if (el.hasAttribute(TAG)) continue
    if (laidOut && (el.scrollTop !== 0 || el.scrollLeft !== 0)) {
      tag(el, { kind: 'scroll', top: el.scrollTop, left: el.scrollLeft })
      continue
    }
    if (el.matches(PDF_PAGE_SELECTOR) && el.querySelector('canvas')) {
      const redraw = hooks.pdfPage?.(el)
      if (redraw) {
        tag(el, { kind: 'pdf-page', redraw })
        continue
      }
    }
    if (el.tagName === 'CANVAS') {
      if (!el.closest(PDF_PAGE_SELECTOR) || !hooks.pdfPage) {
        tag(el, { kind: 'canvas', el: el as HTMLCanvasElement })
      }
    } else if (el.tagName === 'IMG') {
      const src = (el as HTMLImageElement).currentSrc || el.getAttribute('src')
      if (src && !src.startsWith('data:')) {
        tag(el, { kind: 'image', src, width: laidOut ? el.clientWidth : 0 })
      }
    } else if (el.tagName === 'VIDEO') {
      tag(el, { kind: 'video', el: el as HTMLVideoElement })
    } else if (el.tagName === 'IFRAME') {
      tag(el, { kind: 'frame', src: (el as HTMLIFrameElement).src })
    }
  }
  return tagged
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
export function imageLike(el: Element, src: string | null): HTMLElement {
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

export function blobToDataUrl(
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
