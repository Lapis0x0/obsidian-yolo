/**
 * Unit tests for pdfSelectionHighlightController — focused on the
 * anchor/paint decoupling contract added in the 2026-08-16 addendum to
 * docs/plans/2026-08-16-pdf-annotation-quotes.md ("锚点与涂色必须解耦"):
 * `addHighlight` must always build the anchor (offsets, ranges, the
 * `textlayerrendered` resubscription) even when painting is disabled, either
 * by the caller's `options.paint` or by the CSS Custom Highlight API being
 * unavailable — only the `highlight.add`/`delete` calls are conditional.
 *
 * Runs in the default node environment (this repo has no jsdom dependency —
 * see captureCanvasRegion.test.ts for the same hand-rolled-DOM pattern) and
 * mocks only the minimal surface the controller touches: TreeWalker-based
 * text-node discovery, Range construction, a `.page`/`.textLayer` element
 * pair, a PDF.js-shaped eventBus, and the CSS Custom Highlight API.
 */

import type { WorkspaceLeaf } from 'obsidian'
import { Platform, TFile } from 'obsidian'

// ---------------------------------------------------------------------------
// Minimal DOM mocks required by the controller
// ---------------------------------------------------------------------------

class FakeText {
  __layer: FakeTextLayer | null = null
  constructor(public textContent: string) {}
  get length(): number {
    return this.textContent.length
  }
}

type FakeTextLayer = {
  __textNodes: FakeText[]
  ownerDocument: { createRange: () => FakeRange }
}

/**
 * Flat character offset of a boundary into the layer's concatenated text —
 * the same basis the controller's offsets use. Element containers (a boundary
 * that landed on `.textLayer` itself rather than inside a text node, which is
 * exactly what a drag past a trailing period produces) collapse to either end
 * of the layer, since `selectNodeContents` is the only element boundary the
 * controller sets.
 */
function flatOffset(container: unknown, offset: number): number {
  if (container instanceof FakeText) {
    const nodes = container.__layer?.__textNodes ?? [container]
    const before = nodes.slice(0, nodes.indexOf(container))
    return before.reduce((sum, n) => sum + n.length, 0) + offset
  }
  const layer = container as FakeTextLayer
  const total = layer.__textNodes.reduce((sum, n) => sum + n.length, 0)
  return offset === 0 ? 0 : total
}

function layerOf(container: unknown): FakeTextLayer | null {
  return container instanceof FakeText
    ? container.__layer
    : ((container as FakeTextLayer | null) ?? null)
}

class FakeRange {
  startContainer: unknown = null
  startOffset = 0
  endContainer: unknown = null
  endOffset = 0
  setStart(node: unknown, offset: number): void {
    this.startContainer = node
    this.startOffset = offset
  }
  setEnd(node: unknown, offset: number): void {
    this.endContainer = node
    this.endOffset = offset
  }
  selectNodeContents(layer: FakeTextLayer): void {
    this.startContainer = layer
    this.startOffset = 0
    this.endContainer = layer
    this.endOffset = layer.__textNodes.length
  }
  toString(): string {
    const layer = layerOf(this.startContainer) ?? layerOf(this.endContainer)
    if (!layer) return ''
    const text = layer.__textNodes.map((n) => n.textContent).join('')
    return text.slice(
      flatOffset(this.startContainer, this.startOffset),
      flatOffset(this.endContainer, this.endOffset),
    )
  }
}

function makeTextLayer(texts: string[]): FakeTextLayer {
  const layer: FakeTextLayer = {
    __textNodes: texts.map((t) => new FakeText(t)),
    ownerDocument: { createRange: () => new FakeRange() },
  }
  for (const node of layer.__textNodes) node.__layer = layer
  return layer
}

function makePageEl(textLayer: FakeTextLayer): {
  querySelector: (sel: string) => FakeTextLayer | null
} {
  return {
    querySelector: (sel: string) => (sel === '.textLayer' ? textLayer : null),
  }
}

type FakeEventBus = {
  on: (event: string, cb: (...args: any[]) => void) => void
  off: (event: string, cb: (...args: any[]) => void) => void
  emit: (event: string, payload: unknown) => void
}

function makeEventBus(): FakeEventBus {
  const handlers = new Map<string, Set<(...args: any[]) => void>>()
  return {
    on: (event, cb) => {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)?.add(cb)
    },
    off: (event, cb) => {
      handlers.get(event)?.delete(cb)
    },
    emit: (event, payload) => {
      for (const cb of handlers.get(event) ?? []) cb(payload)
    },
  }
}

/**
 * A leaf whose `.page[data-page-number]` query result can be swapped after
 * creation — used to simulate PDF.js recreating the page DOM on
 * `textlayerrendered` (scale change, etc.) the same way the real viewer does.
 */
function makeLeaf(): {
  leaf: WorkspaceLeaf
  eventBus: FakeEventBus
  setPageEl: (el: ReturnType<typeof makePageEl> | null) => void
} {
  let currentPageEl: ReturnType<typeof makePageEl> | null = null
  const eventBus = makeEventBus()
  const leaf = {
    view: {
      containerEl: {
        querySelector: (sel: string) =>
          sel.startsWith('.page[') ? currentPageEl : null,
      },
      viewer: { child: { pdfViewer: { eventBus } } },
    },
  } as unknown as WorkspaceLeaf
  return {
    leaf,
    eventBus,
    setPageEl: (el) => {
      currentPageEl = el
    },
  }
}

class FakeHighlightSet {
  items = new Set<unknown>()
  add(item: unknown): void {
    this.items.add(item)
  }
  delete(item: unknown): void {
    this.items.delete(item)
  }
}

function fakeRangeFor(node: FakeText, start: number, end: number): Range {
  const range = new FakeRange()
  range.startContainer = node
  range.startOffset = start
  range.endContainer = node
  range.endOffset = end
  return range as unknown as Range
}

const FILE = new TFile()

// ---------------------------------------------------------------------------
// Global DOM/CSS Highlight API mocks — established before each test so the
// controller's module-scope singleton starts clean every time.
// ---------------------------------------------------------------------------

beforeAll(() => {
  ;(global as any).document = {
    createTreeWalker: (root: FakeTextLayer) => {
      const nodes = root.__textNodes ?? []
      let i = -1
      return {
        nextNode: () => {
          i += 1
          return i < nodes.length ? nodes[i] : null
        },
      }
    },
    createRange: () => new FakeRange(),
  }
  ;(global as any).NodeFilter = { SHOW_TEXT: 4 }
})

afterAll(() => {
  delete (global as any).document
  delete (global as any).NodeFilter
  delete (global as any).window
})

beforeEach(() => {
  ;(global as any).window = {
    Highlight: FakeHighlightSet,
    CSS: { highlights: new Map<string, FakeHighlightSet>() },
  }
  Platform.isMobile = false
})

afterEach(() => {
  // Guard against a test leaving stale entries in the singleton controller —
  // clearAll() itself must tolerate whatever window/CSS state the test left
  // behind, which is part of what's under test here.
  pdfSelectionHighlightController.clearAll()
})

import { pdfSelectionHighlightController } from './pdfSelectionHighlightController'

function getPaintedSet(): FakeHighlightSet | undefined {
  return (global as any).window.CSS.highlights.get('yolo-pdf-selection')
}

function getEntry(id: string): any {
  return (pdfSelectionHighlightController as any).entries.get(id)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PdfSelectionHighlightController — anchor/paint decoupling', () => {
  it('creates the anchor entry and skips painting when options.paint is false', () => {
    const textLayer = makeTextLayer(['hello world'])
    const pageEl = makePageEl(textLayer)
    const { leaf, setPageEl } = makeLeaf()
    setPageEl(pageEl)

    const range = fakeRangeFor(textLayer.__textNodes[0], 0, 5)
    pdfSelectionHighlightController.addHighlight(
      leaf,
      'id-1',
      { range, pageNumber: 1, file: FILE },
      'pinned',
      'chat',
      { paint: false },
    )

    const entry = getEntry('id-1')
    expect(entry).toBeDefined()
    expect(entry.ranges).toHaveLength(1)
    expect(entry.startOffset).toBe(0)
    expect(entry.endOffset).toBe(5)
    expect(entry.paint).toBe(false)
    // Nothing should have been painted into the CSS Custom Highlight registry.
    expect(getPaintedSet()?.items.size ?? 0).toBe(0)
  })

  it('paints when options.paint is true (or omitted) and the API is available', () => {
    const textLayer = makeTextLayer(['hello world'])
    const pageEl = makePageEl(textLayer)
    const { leaf, setPageEl } = makeLeaf()
    setPageEl(pageEl)

    const range = fakeRangeFor(textLayer.__textNodes[0], 0, 5)
    pdfSelectionHighlightController.addHighlight(
      leaf,
      'id-2',
      { range, pageNumber: 1, file: FILE },
      'pinned',
      'chat',
    )

    const entry = getEntry('id-2')
    expect(entry.paint).toBe(true)
    expect(getPaintedSet()?.items.size).toBe(1)
  })

  it('still creates the anchor entry when the CSS Custom Highlight API is unavailable', () => {
    ;(global as any).window = {} // no Highlight, no CSS — matches unsupported runtimes

    const textLayer = makeTextLayer(['hello world'])
    const pageEl = makePageEl(textLayer)
    const { leaf, setPageEl } = makeLeaf()
    setPageEl(pageEl)

    const range = fakeRangeFor(textLayer.__textNodes[0], 0, 5)
    expect(() =>
      pdfSelectionHighlightController.addHighlight(
        leaf,
        'id-3',
        { range, pageNumber: 1, file: FILE },
        'pinned',
        'chat',
      ),
    ).not.toThrow()

    const entry = getEntry('id-3')
    expect(entry).toBeDefined()
    expect(entry.ranges).toHaveLength(1)
  })

  it('rebuilds ranges on textlayerrendered without painting when the entry is unpainted', () => {
    const textLayer = makeTextLayer(['hello world'])
    const pageEl = makePageEl(textLayer)
    const { leaf, eventBus, setPageEl } = makeLeaf()
    setPageEl(pageEl)

    const range = fakeRangeFor(textLayer.__textNodes[0], 0, 5)
    pdfSelectionHighlightController.addHighlight(
      leaf,
      'id-4',
      { range, pageNumber: 1, file: FILE },
      'pinned',
      'chat',
      { paint: false },
    )

    const originalRange = getEntry('id-4').ranges[0]

    // Simulate PDF.js recreating the page DOM on re-render (scale change).
    const rebuiltTextLayer = makeTextLayer(['hello world'])
    setPageEl(makePageEl(rebuiltTextLayer))
    eventBus.emit('textlayerrendered', { pageNumber: 1 })

    const rebuiltRange = getEntry('id-4').ranges[0]
    expect(rebuiltRange).not.toBe(originalRange)
    expect((rebuiltRange as unknown as FakeRange).startContainer).toBe(
      rebuiltTextLayer.__textNodes[0],
    )
    // Still never painted.
    expect(getPaintedSet()?.items.size ?? 0).toBe(0)
  })

  it('repaints on textlayerrendered rebuild when the entry is painted', () => {
    const textLayer = makeTextLayer(['hello world'])
    const pageEl = makePageEl(textLayer)
    const { leaf, eventBus, setPageEl } = makeLeaf()
    setPageEl(pageEl)

    const range = fakeRangeFor(textLayer.__textNodes[0], 0, 5)
    pdfSelectionHighlightController.addHighlight(
      leaf,
      'id-5',
      { range, pageNumber: 1, file: FILE },
      'pinned',
      'chat',
      { paint: true },
    )
    expect(getPaintedSet()?.items.size).toBe(1)

    const rebuiltTextLayer = makeTextLayer(['hello world'])
    setPageEl(makePageEl(rebuiltTextLayer))
    eventBus.emit('textlayerrendered', { pageNumber: 1 })

    // Old range removed, new range added — net count unchanged.
    expect(getPaintedSet()?.items.size).toBe(1)
    expect(getPaintedSet()?.items.has(getEntry('id-5').ranges[0])).toBe(true)
  })

  it('clearById removes an unpainted entry without throwing', () => {
    const textLayer = makeTextLayer(['hello world'])
    const pageEl = makePageEl(textLayer)
    const { leaf, setPageEl } = makeLeaf()
    setPageEl(pageEl)

    const range = fakeRangeFor(textLayer.__textNodes[0], 0, 5)
    pdfSelectionHighlightController.addHighlight(
      leaf,
      'id-6',
      { range, pageNumber: 1, file: FILE },
      'pinned',
      'chat',
      { paint: false },
    )

    expect(() =>
      pdfSelectionHighlightController.clearById('id-6'),
    ).not.toThrow()
    expect(getEntry('id-6')).toBeUndefined()
  })

  it('clearById does not throw when the CSS Custom Highlight API is unavailable', () => {
    const textLayer = makeTextLayer(['hello world'])
    const pageEl = makePageEl(textLayer)
    const { leaf, setPageEl } = makeLeaf()
    setPageEl(pageEl)

    const range = fakeRangeFor(textLayer.__textNodes[0], 0, 5)
    pdfSelectionHighlightController.addHighlight(
      leaf,
      'id-7',
      { range, pageNumber: 1, file: FILE },
      'pinned',
      'chat',
    )

    // API disappears after creation (e.g. moved to an unsupported window).
    ;(global as any).window = {}

    expect(() =>
      pdfSelectionHighlightController.clearById('id-7'),
    ).not.toThrow()
    expect(getEntry('id-7')).toBeUndefined()
  })

  it('keeps the existing mobile no-paint policy for chat/quickask owners even when options.paint is true', () => {
    Platform.isMobile = true

    const textLayer = makeTextLayer(['hello world'])
    const pageEl = makePageEl(textLayer)
    const { leaf, setPageEl } = makeLeaf()
    setPageEl(pageEl)

    const range = fakeRangeFor(textLayer.__textNodes[0], 0, 5)
    pdfSelectionHighlightController.addHighlight(
      leaf,
      'id-8',
      { range, pageNumber: 1, file: FILE },
      'pinned',
      'chat',
      { paint: true },
    )

    const entry = getEntry('id-8')
    // Anchor still created — mobile only forgoes painting, never the entry.
    expect(entry).toBeDefined()
    expect(entry.paint).toBe(false)
    expect(getPaintedSet()?.items.size ?? 0).toBe(0)
  })
})

describe('PdfSelectionHighlightController — selection boundaries on elements', () => {
  /**
   * Dragging to the end of a line — e.g. just past the trailing period —
   * leaves the end boundary on `.textLayer` itself rather than inside a text
   * node. Offsets must still resolve: previously this produced no entry at
   * all, which silently killed the annotation bubble and comment editor.
   */
  it('resolves offsets when the end boundary lands on the text layer element', () => {
    const textLayer = makeTextLayer(['first line.', 'second line.'])
    const pageEl = makePageEl(textLayer)
    const { leaf, setPageEl } = makeLeaf()
    setPageEl(pageEl)

    const range = new FakeRange()
    range.setStart(textLayer.__textNodes[0], 0)
    // End on the element, past the last child — what Chromium reports for a
    // selection dragged through the final period of the layer.
    range.setEnd(textLayer, textLayer.__textNodes.length)

    pdfSelectionHighlightController.addHighlight(
      leaf,
      'id-9',
      { range: range as unknown as Range, pageNumber: 1, file: FILE },
      'pinned',
      'chat',
      { paint: false },
    )

    const entry = getEntry('id-9')
    expect(entry).toBeDefined()
    expect(entry.startOffset).toBe(0)
    expect(entry.endOffset).toBe('first line.second line.'.length)
  })
})
