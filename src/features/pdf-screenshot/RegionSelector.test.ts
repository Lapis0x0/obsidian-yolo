/**
 * Unit tests for RegionSelector.
 *
 * These tests run in the default node environment and provide a minimal
 * DOM stub. We use plain objects as event mocks since MouseEvent /
 * KeyboardEvent / Event constructors are not available in node.
 */

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

function makeMouseEvent(
  type: string,
  options: { clientX?: number; clientY?: number; button?: number } = {},
): MouseEvent {
  const prevented = { value: false }
  const stopped = { value: false }
  return {
    type,
    button: options.button ?? 0,
    clientX: options.clientX ?? 0,
    clientY: options.clientY ?? 0,
    bubbles: true,
    cancelable: true,
    preventDefault: () => {
      prevented.value = true
    },
    stopPropagation: () => {
      stopped.value = true
    },
  } as unknown as MouseEvent
}

function makeKeyboardEvent(key: string): KeyboardEvent {
  const prevented = { value: false }
  const stopped = { value: false }
  return {
    type: 'keydown',
    key,
    bubbles: true,
    cancelable: true,
    preventDefault: () => {
      prevented.value = true
    },
    stopPropagation: () => {
      stopped.value = true
    },
  } as unknown as KeyboardEvent
}

// ---------------------------------------------------------------------------
// Minimal DOM mock
// ---------------------------------------------------------------------------

type MockElement = {
  className: string
  textContent: string
  style: Record<string, string>
  children: MockElement[]
  getAttribute: jest.Mock
  setAttribute: jest.Mock
  appendChild: (child: MockElement) => MockElement
  remove: () => void
  dispatchEvent: (event: unknown) => void
  addEventListener: (
    type: string,
    handler: (e: unknown) => void,
    opts?: unknown,
  ) => void
  removeEventListener: (type: string, handler: (e: unknown) => void) => void
  getBoundingClientRect: () => DOMRect
  innerHTML: string
}

function makeMockElement(): MockElement {
  const listeners: Record<string, Set<(e: unknown) => void>> = {}
  const el: MockElement = {
    className: '',
    textContent: '',
    style: {},
    children: [],
    innerHTML: '',
    getAttribute: jest.fn(),
    setAttribute: jest.fn(),
    appendChild(child) {
      this.children.push(child)
      return child
    },
    remove: jest.fn(),
    addEventListener(type, handler, _opts?) {
      if (!listeners[type]) listeners[type] = new Set()
      listeners[type].add(handler)
    },
    removeEventListener(type, handler) {
      listeners[type]?.delete(handler)
    },
    dispatchEvent(event) {
      const e = event as { type: string }
      listeners[e.type]?.forEach((h) => h(event))
    },
    getBoundingClientRect: () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 1000,
        right: 800,
        bottom: 1000,
      }) as DOMRect,
  }
  return el
}

// The shared canvas mock returned by elementsFromPoint
let sharedCanvas: MockElement
// The shared document mock
let mockDoc: {
  createElement: (tag: string) => MockElement
  elementsFromPoint: (x: number, y: number) => MockElement[]
  addEventListener: (
    type: string,
    h: (e: unknown) => void,
    opts?: unknown,
  ) => void
  removeEventListener: (type: string, h: (e: unknown) => void) => void
  dispatchEvent: (event: unknown) => void
}

// Make a class for the canvas mock so that `instanceof HTMLCanvasElement` works
class MockHTMLCanvasElement {}

function setupGlobalDocument() {
  // Patch HTMLCanvasElement globally so instanceof checks work
  ;(global as Record<string, unknown>).HTMLCanvasElement = MockHTMLCanvasElement

  sharedCanvas = makeMockElement()
  // Cast sharedCanvas to be an instance of MockHTMLCanvasElement
  Object.setPrototypeOf(sharedCanvas, MockHTMLCanvasElement.prototype)
  sharedCanvas.getBoundingClientRect = () =>
    ({
      left: 100,
      top: 200,
      width: 400,
      height: 600,
      right: 500,
      bottom: 800,
    }) as DOMRect
  const pageDiv = makeMockElement()
  pageDiv.getAttribute.mockImplementation((attr: string) =>
    attr === 'data-page-number' ? '3' : null,
  )
  ;(sharedCanvas as Record<string, unknown>).closest = (_sel: string) => pageDiv

  const docListeners: Record<string, Set<(e: unknown) => void>> = {}
  mockDoc = {
    createElement: (_tag: string) => makeMockElement(),
    elementsFromPoint: (_x: number, _y: number) => [sharedCanvas],
    addEventListener(type, handler, _opts?) {
      if (!docListeners[type]) docListeners[type] = new Set()
      docListeners[type].add(handler)
    },
    removeEventListener(type, handler) {
      docListeners[type]?.delete(handler)
    },
    dispatchEvent(event) {
      const e = event as { type: string }
      docListeners[e.type]?.forEach((h) => h(event))
    },
  }
  ;(global as Record<string, unknown>).document = mockDoc
}

function teardownGlobalDocument() {
  delete (global as Record<string, unknown>).document
  delete (global as Record<string, unknown>).HTMLCanvasElement
}

// ---------------------------------------------------------------------------
// Import AFTER global stub setup helper is defined
// ---------------------------------------------------------------------------

import { RegionSelector, SelectedRegion } from './RegionSelector'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RegionSelector', () => {
  let container: MockElement

  beforeEach(() => {
    setupGlobalDocument()
    container = makeMockElement()
    container.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 1000,
        right: 800,
        bottom: 1000,
      }) as DOMRect
  })

  afterEach(() => {
    teardownGlobalDocument()
  })

  it('appends an overlay element to the container on mount', () => {
    const selector = new RegionSelector(container as unknown as HTMLElement, {
      onComplete: jest.fn(),
      onCancel: jest.fn(),
    })
    selector.mount()
    expect(container.children.length).toBe(1)
    const overlay = container.children[0]
    expect(overlay.className).toContain('yolo-pdf-region-overlay')
  })

  it('calls onComplete with correct region on mouseup', () => {
    const onComplete = jest.fn()
    const onCancel = jest.fn()

    const selector = new RegionSelector(container as unknown as HTMLElement, {
      onComplete,
      onCancel,
    })
    selector.mount()

    const overlay = container.children[0]

    // Simulate mousedown on the overlay at viewport (150, 250)
    overlay.dispatchEvent(
      makeMouseEvent('mousedown', { clientX: 150, clientY: 250 }),
    )
    // Simulate mousemove (registered on document)
    mockDoc.dispatchEvent(
      makeMouseEvent('mousemove', { clientX: 250, clientY: 350 }),
    )
    // Simulate mouseup (registered on document)
    mockDoc.dispatchEvent(
      makeMouseEvent('mouseup', { clientX: 250, clientY: 350 }),
    )

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()

    const region: SelectedRegion = onComplete.mock.calls[0][0]
    // canvas.getBoundingClientRect: left=100, top=200
    // selection viewport rect: left=min(150,250)=150, top=min(250,350)=250
    // region.x = 150 - 100 = 50, region.y = 250 - 200 = 50
    expect(region.x).toBe(50)
    expect(region.y).toBe(50)
    expect(region.width).toBe(100) // |250-150|
    expect(region.height).toBe(100) // |350-250|
    expect(region.pageNumber).toBe(3)
  })

  it('calls onCancel when ESC is pressed', () => {
    const onComplete = jest.fn()
    const onCancel = jest.fn()

    const selector = new RegionSelector(container as unknown as HTMLElement, {
      onComplete,
      onCancel,
    })
    selector.mount()

    const overlay = container.children[0]
    overlay.dispatchEvent(
      makeMouseEvent('mousedown', { clientX: 100, clientY: 100 }),
    )
    mockDoc.dispatchEvent(makeKeyboardEvent('Escape'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('calls onCancel when drag area is too small (< 4px)', () => {
    const onComplete = jest.fn()
    const onCancel = jest.fn()

    const selector = new RegionSelector(container as unknown as HTMLElement, {
      onComplete,
      onCancel,
    })
    selector.mount()

    const overlay = container.children[0]
    overlay.dispatchEvent(
      makeMouseEvent('mousedown', { clientX: 100, clientY: 100 }),
    )
    mockDoc.dispatchEvent(
      makeMouseEvent('mouseup', { clientX: 102, clientY: 102 }),
    )

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('unmount is idempotent (no error on double call)', () => {
    const selector = new RegionSelector(container as unknown as HTMLElement, {
      onComplete: jest.fn(),
      onCancel: jest.fn(),
    })
    selector.mount()
    expect(() => {
      selector.unmount()
      selector.unmount()
    }).not.toThrow()
  })
})
